import 'dotenv/config';
import { exec } from 'child_process';
import fs from 'fs';
import logger from './utils/logger.js';
import { initClient, getUsdcBalance } from './services/client.js';
import { startMMDetector, stopMMDetector, checkCurrentMarket } from './services/mmDetector.js';
import {
  loadMartingaleState,
  saveMartingaleState,
  calcNextBetSize,
  registerOutcome,
  printSummary,
} from './services/martingale.js';
import { checkAndRedeemPositions } from './services/redeemer.js';
import { addPosition, getOpenPositions } from './services/position.js';
import { Side, OrderType } from '@polymarket/clob-client';
import config from './config/index.js';
import {
  sendMessage,
  notifyBuy,
  notifyWin,
  notifyLoss,
  notifyError,
  startPolling,
  stopPolling,
} from './services/telegram.js';

const CFG = {
  baseSize:        parseFloat(process.env.MARTINGALE_BASE_SIZE     ?? '1'),
  multiplier:      parseFloat(process.env.MARTINGALE_MULTIPLIER    ?? '2'),
  maxSteps:        parseInt  (process.env.MARTINGALE_MAX_STEPS     ?? '5', 10),
  resetOnWin:      (process.env.MARTINGALE_RESET_ON_WIN  ?? 'true') === 'true',
  targetProfitPct: parseFloat(process.env.MARTINGALE_TARGET_PROFIT ?? '10'),
  side:            (process.env.MARTINGALE_SIDE     ?? 'YES').toUpperCase(),
  assets:          (process.env.MARTINGALE_ASSETS   ?? 'btc').split(',').map(a => a.trim()),
  duration:        process.env.MARTINGALE_DURATION  ?? '5m',
  dryRun:          (process.env.DRY_RUN ?? 'true') === 'true',
};

config.mmAssets   = CFG.assets;
config.mmDuration = CFG.duration;

// ── Asset state ───────────────────────────────────────────────
let activeAsset = CFG.assets[0] ?? 'btc';
let pendingAsset = null;
let sideMode = 'auto'; // 'auto' | 'yes' | 'no'
let betMode = 'martingale'; // 'martingale' | 'flat'
let recentBets = []; // last 3 bet directions for reversal detection

// ── Multi-market manual mode ──────────────────────────────────
let tradingMode = 'btc'; // 'btc' | 'sports' | 'politics'
let searchResults = []; // store search results
let selectedMarket = null; // market chosen by user
let llmRecommendation = null; // LLM analysis result

const ASSET_BINANCE = { btc: 'BTCUSDT', sol: 'SOLUSDT', eth: 'ETHUSDT', xrp: 'XRPUSDT', doge: 'DOGEUSDT' };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function safeNotify(fn) {
  try {
    await Promise.race([fn(), new Promise((_, r) => setTimeout(() => r(new Error('notify timeout')), 5000))]);
  } catch(e) {
    logger.warn('[Telegram] notify timeout/error: ' + e.message);
  }
}

const BALANCE_ALERT_THRESHOLD = parseFloat(process.env.BALANCE_ALERT_THRESHOLD ?? '25');
let balanceAlertFired = false;

let flatBetSize    = 1; // default $1, only used in flat mode
let isProcessing   = false;
let isShuttingDown = false;
let redeemerTimer  = null;
let consecutiveLossesAtMax = 0; // existing auto-reset logic (kept)

// ── V2 tracking variables ─────────────────────────────────────
let dailyTradeCount = 0;
let dailyPnl        = 0;
let lastResetDate   = '';
let consecutiveLosses = 0;
let pauseUntil      = null;
let pauseIsDaily    = false; // true when pause was triggered by daily loss limit
let startingBalance = null;

// ── [V2 L1] Daily reset ───────────────────────────────────────
function checkDailyReset() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  if (lastResetDate !== today) {
    lastResetDate     = today;
    dailyTradeCount   = 0;
    dailyPnl          = 0;
    consecutiveLosses = 0;
    if (pauseIsDaily) {
      pauseUntil   = null;
      pauseIsDaily = false;
    }
    logger.info(`[V2] Daily reset — date=${today} trades=0 pnl=$0 consecutiveLosses=0`);
    updateCircuitBreakerState();
  }
}

// ── [Fix 1] Persist circuit breaker state to shared file ──────
function updateCircuitBreakerState() {
  try {
    fs.writeFileSync('data/circuit-breaker.json', JSON.stringify({
      consecutiveLosses,
      pauseUntil,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch (err) {
    logger.warn(`[CircuitBreaker] Failed to save state: ${err.message}`);
  }
}

// ── Dashboard data writer ─────────────────────────────────────
function writeDashboardData(updates) {
  try {
    let current = {};
    try { current = JSON.parse(fs.readFileSync('data/dashboard.json', 'utf8')); } catch { /* first write */ }
    const merged = { ...current, ...updates, updatedAt: new Date().toISOString() };
    fs.writeFileSync('data/dashboard.json', JSON.stringify(merged, null, 2));
  } catch (err) {
    logger.warn(`[Dashboard] Write failed: ${err.message}`);
  }
}

// ── [Improvement 5] Global daily trade limit ──────────────────
const MAX_DAILY_TRADES = 80;

// ── [V2 L1] Session info ──────────────────────────────────────
function getSessionInfo() {
  const h = new Date().getUTCHours();
  if (h >= 1 && h < 7)  return { label: 'PRIME',      confidenceMin: 0.33 };
  if (h >= 7 && h < 13) return { label: 'OKAY',       confidenceMin: 0.55 };
  return                       { label: 'RESTRICTED', confidenceMin: 0.65 };
}

// ── [V2 L3] Confidence threshold by session + step ────────────
function getConfidenceThreshold(session, step) {
  if (step === 0) return session.confidenceMin;
  // Recovery steps (step >= 1) require higher confidence
  const recovery = { PRIME: 0.65, OKAY: 0.67, RESTRICTED: 0.67 };
  return recovery[session.label];
}

// ── [V2 L2] RSI (Wilder smoothing) ───────────────────────────
function calcRSI(closes, period = 7) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// ── [V2 L2] Bollinger Bands ───────────────────────────────────
function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice    = closes.slice(-period);
  const sma      = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - sma) ** 2, 0) / period;
  const stddev   = Math.sqrt(variance);
  return { upper: sma + mult * stddev, lower: sma - mult * stddev };
}

// ── [V2 L2] Advanced signal: RSI + Bollinger Bands + Wick ────
async function getAdvancedSignal(asset) {
  const symbol = ASSET_BINANCE[asset] ?? 'BTCUSDT';
  try {
    const res = await Promise.race([
      fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=30`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Binance timeout')), 5000)),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const klines = await res.json();

    const opens  = klines.map(k => parseFloat(k[1]));
    const highs  = klines.map(k => parseFloat(k[2]));
    const lows   = klines.map(k => parseFloat(k[3]));
    const closes = klines.map(k => parseFloat(k[4]));
    const last   = klines.length - 1;

    // Signal 1: RSI(7)
    const rsiVal = calcRSI(closes, 7);
    let rsiSig = null;
    if (rsiVal !== null) {
      if (rsiVal < 22) rsiSig = 'YES';       // oversold
      else if (rsiVal > 78) rsiSig = 'NO';   // overbought
    }

    // Signal 2: Bollinger Band touch (20,2)
    const bb    = calcBB(closes, 20, 2);
    const price = closes[last];
    let bbSig   = null;
    if (bb) {
      if (price <= bb.lower) bbSig = 'YES';
      else if (price >= bb.upper) bbSig = 'NO';
    }

    // Signal 3: Rejection wick (last candle)
    const open      = opens[last];
    const high      = highs[last];
    const low       = lows[last];
    const close     = closes[last];
    const body      = Math.abs(close - open);
    const range     = high - low;
    const lowerWick = Math.min(open, close) - low;
    const upperWick = high - Math.max(open, close);
    let wickSig     = null;
    if (range > 0) {
      if (lowerWick > body * 2 && lowerWick > range * 0.6) wickSig = 'YES'; // hammer
      else if (upperWick > body * 2 && upperWick > range * 0.6) wickSig = 'NO'; // shooting star
    }

    // Voting
    const yesVotes = [rsiSig, bbSig, wickSig].filter(v => v === 'YES').length;
    const noVotes  = [rsiSig, bbSig, wickSig].filter(v => v === 'NO').length;
    let direction, confidence;
    if (yesVotes >= 2) {
      direction  = 'YES';
      confidence = yesVotes / 3;
    } else if (noVotes >= 2) {
      direction  = 'NO';
      confidence = noVotes / 3;
    } else {
      direction  = null;
      confidence = 0.33;
    }

    return { direction, confidence, rsiSig, bbSig, wickSig };
  } catch (err) {
    logger.warn(`[V2] Advanced signal error: ${err.message} — no advanced signal`);
    return {
      direction:  null,
      confidence: 0.33,
      rsiSig:     null,
      bbSig:      null,
      wickSig:    null,
    };
  }
}

// ── [Improvement 2] Volume spike filter ──────────────────────
async function getVolumeFilter(asset) {
  const symbol = ASSET_BINANCE[asset] ?? 'BTCUSDT';
  try {
    const res = await Promise.race([
      fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=10`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Binance timeout')), 5000)),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const klines = await res.json();
    const volumes = klines.map(k => parseFloat(k[5]));
    const avgVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
    const curVol = volumes[volumes.length - 1];
    const ratio  = avgVol > 0 ? curVol / avgVol : 1;
    if (ratio > 2.5) {
      logger.warn(`[Volume] ⚠️ Volume spike (${ratio.toFixed(1)}x avg) — signal less reliable`);
    } else {
      logger.info(`[Volume] Normal (${ratio.toFixed(1)}x avg)`);
    }
    return { spike: ratio > 2.5, ratio };
  } catch (err) {
    logger.warn(`[Volume] Filter error: ${err.message}`);
    return { spike: false, ratio: 1 };
  }
}

// ── [Improvement 3] Spread analysis ──────────────────────────
async function getSpreadAnalysis(client, market) {
  try {
    const [yesMidRes, noMidRes] = await Promise.all([
      Promise.race([
        client.getMidpoint(market.yesTokenId),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]),
      Promise.race([
        client.getMidpoint(market.noTokenId),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]),
    ]);
    const yesMid = parseFloat(yesMidRes?.mid ?? yesMidRes ?? '0.5') || 0.5;
    const noMid  = parseFloat(noMidRes?.mid  ?? noMidRes  ?? '0.5') || 0.5;
    const spread = Math.abs(yesMid + noMid - 1.0);
    if (spread > 0.08) {
      logger.warn(`[Spread] ⚠️ Wide spread: ${spread.toFixed(3)} — liquidity poor`);
    } else {
      logger.info(`[Spread] OK: ${spread.toFixed(3)}`);
    }
    return { spread, wide: spread > 0.08 };
  } catch (err) {
    logger.warn(`[Spread] Analysis error: ${err.message}`);
    return { spread: 0, wide: false };
  }
}

// ── [Feature 3] Reversal signal ───────────────────────────────
function getReversalSignal(mid, history) {
  if (history.length >= 3) {
    const last3 = history.slice(-3);
    if (last3.every(s => s === 'YES') && mid > 0.55) return 'NO';
    if (last3.every(s => s === 'NO') && mid < 0.45) return 'YES';
  }
  if (mid > 0.70) return 'NO';
  if (mid < 0.30) return 'YES';
  return null;
}

// ── Balance alert check ───────────────────────────────────────
async function checkBalanceAlert() {
  try {
    const balance = await getUsdcBalance();
    if (balance >= BALANCE_ALERT_THRESHOLD) {
      if (!balanceAlertFired) {
        balanceAlertFired = true;
        logger.info(`[Balance] $${balance.toFixed(2)} ≥ threshold $${BALANCE_ALERT_THRESHOLD} — sending alert`);
        await safeNotify(() => sendMessage(
          `💰 <b>BALANCE ALERT</b>\n` +
          `Current balance: <b>$${balance.toFixed(2)}</b>\n` +
          `Target $${BALANCE_ALERT_THRESHOLD} reached!\n` +
          `Consider withdrawing $10 at polymarket.com/portfolio`,
        ));
      }
    } else {
      balanceAlertFired = false;
    }
  } catch (err) {
    logger.warn(`[Balance] Check failed: ${err.message}`);
  }
}

// ── LLM model rotation ────────────────────────────────────────
const LLM_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-3-27b-it:free',
  'openrouter/free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'deepseek/deepseek-r1:free',
  'nvidia/llama-3.1-nemotron-70b-instruct:free',
  'microsoft/phi-4-reasoning:free',
  'allenai/olmo-3.1-32b-think:free',
  'tngtech/deepseek-r1t-chimera:free',
  'mistralai/mistral-nemo:free',
];
let llmModelIndex  = 0;
let llmSuccessCount = 0;

/**
 * Call OpenRouter with automatic fallback on 429/404.
 * - 429 or 404 → advance to next model immediately and retry
 * - success    → increment llmSuccessCount; reset to index 0 after 10 successes
 */
async function callLLM(apiKey, messages) {
  const tried = new Set();
  while (tried.size < LLM_MODELS.length) {
    const idx   = llmModelIndex % LLM_MODELS.length;
    const model = LLM_MODELS[idx];
    if (tried.has(model)) break;
    tried.add(model);

    try {
      const res = await Promise.race([
        fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model, messages, max_tokens: 5 }),
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('LLM timeout')), 5000)),
      ]);

      if (res.status === 429 || res.status === 404) {
        logger.warn(`[AI] Model ${model} returned ${res.status} — switching to next`);
        llmModelIndex++;
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      llmSuccessCount++;
      if (llmSuccessCount >= 10) {
        llmSuccessCount = 0;
        llmModelIndex   = 0;
        logger.info('[AI] 10 successes — reset model to index 0 (openrouter/free)');
      }
      logger.info(`[AI] Model used: ${model} (index ${idx})`);
      return data;
    } catch (err) {
      logger.warn(`[AI] Model ${model} error: ${err.message}`);
      llmModelIndex++;
    }
  }
  return null;
}

// ── LLM side suggestion via OpenRouter ───────────────────────
async function getLLMSide(marketName, mid, orderbookSignal) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const prompt =
    `You are a Polymarket trading assistant.\n` +
    `Market: ${marketName}\n` +
    `YES token price: ${mid.toFixed(3)} (0=certain DOWN, 1=certain UP, 0.5=50/50)\n` +
    `Orderbook signal: ${orderbookSignal}\n\n` +
    `Based on the YES price, should I bet YES or NO?\n` +
    `Reply with ONLY one word: YES or NO`;

  try {
    const data = await callLLM(apiKey, [{ role: 'user', content: prompt }]);
    if (!data) return null;
    const text = (data?.choices?.[0]?.message?.content ?? '').trim().toUpperCase();
    if (text === 'YES' || text === 'NO') return text;
    const match = text.match(/\b(YES|NO)\b/);
    return match ? match[1] : null;
  } catch (err) {
    logger.warn(`[AI] LLM request failed: ${err.message}`);
    return null;
  }
}

// ── [Feature 4] LLM recovery suggestion after a loss ─────────
async function getLLMRecovery(lastLoss, currentMarket, mid) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || !lastLoss) return null;

  const prompt =
    `Previous bet LOST: ${lastLoss.market ?? 'unknown'}, Side: ${lastLoss.side ?? 'unknown'}, PnL: ${(lastLoss.pnl ?? 0).toFixed(2)}\n` +
    `Current market: ${currentMarket}\n` +
    `YES price: ${mid.toFixed(3)}\n` +
    `What side should I bet to recover? Reply YES or NO`;

  try {
    const data = await callLLM(apiKey, [{ role: 'user', content: prompt }]);
    if (!data) return null;
    const text = (data?.choices?.[0]?.message?.content ?? '').trim().toUpperCase();
    if (text === 'YES' || text === 'NO') return text;
    const match = text.match(/\b(YES|NO)\b/);
    return match ? match[1] : null;
  } catch (err) {
    logger.warn(`[Learn] LLM recovery request failed: ${err.message}`);
    return null;
  }
}

// ── [Fix 3] Price action following signal ─────────────────────
async function getPriceActionSignal(market) {
  try {
    // Get market start time (eventStartTime)
    const marketStart = new Date(market.eventStartTime ?? market.startTime).getTime();
    const now = Date.now();
    const elapsed = (now - marketStart) / 1000; // seconds elapsed

    // Only use this signal if market has been open > 90 seconds
    if (elapsed < 90) {
      logger.info('[PriceAction] Market too new (<90s) — skipping');
      return null;
    }

    // Fetch 1m candles from Binance (last 5)
    const symbol = ASSET_BINANCE[activeAsset] ?? 'BTCUSDT';
    const res = await Promise.race([
      fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=5`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const candles = await res.json();

    const currentPrice = parseFloat(candles[candles.length - 1][4]); // last close
    const openPrice = parseFloat(candles[candles.length - 2][1]); // 1 min ago open

    // Also get price at market open using market eventStartTime
    // Find the candle closest to market start
    const startCandle = candles[0];
    const startPrice = parseFloat(startCandle[1]); // open of oldest candle

    const changeFromStart = ((currentPrice - startPrice) / startPrice) * 100;
    const changeLastMin = ((currentPrice - openPrice) / openPrice) * 100;

    let signal = null;
    let reason = '';

    // Strong signal: price moved >0.08% from market open
    if (changeFromStart > 0.08) {
      signal = 'YES'; // UP trend
      reason = `+${changeFromStart.toFixed(3)}% from open → UP`;
    } else if (changeFromStart < -0.08) {
      signal = 'NO'; // DOWN trend
      reason = `${changeFromStart.toFixed(3)}% from open → DOWN`;
    }
    // Last minute momentum confirmation
    else if (changeLastMin > 0.05) {
      signal = 'YES';
      reason = `+${changeLastMin.toFixed(3)}% last 1m → UP`;
    } else if (changeLastMin < -0.05) {
      signal = 'NO';
      reason = `${changeLastMin.toFixed(3)}% last 1m → DOWN`;
    } else {
      reason = `flat ${changeFromStart.toFixed(3)}% → no signal`;
    }

    logger.info(`[PriceAction] ${reason} | signal=${signal ?? 'null'}`);
    return signal;

  } catch (err) {
    logger.warn(`[PriceAction] Error: ${err.message}`);
    return null;
  }
}

// ── [Fix 3] Momentum signal (5m price change) ────────────────
async function getMomentumSignal() {
  try {
    const symbol = ASSET_BINANCE[activeAsset] ?? 'BTCUSDT';
    const res = await Promise.race([
      fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=6`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const candles = await res.json();

    const closes = candles.map(k => parseFloat(k[4]));
    const current = closes[closes.length - 1];
    const prev5 = closes[0];
    const change = ((current - prev5) / prev5) * 100;

    let signal = null;
    if (change > 0.1) signal = 'YES';
    else if (change < -0.1) signal = 'NO';

    logger.info(`[Momentum] ${change.toFixed(3)}% (5m) → ${signal ?? 'null'}`);
    return signal;
  } catch (err) {
    logger.warn(`[Momentum] Error: ${err.message}`);
    return null;
  }
}

// ── Smart side selection via orderbook midpoint + LLM ────────
async function getSmartSide(client, market) {
  if (sideMode === 'yes') { logger.info('[Smart] FORCE YES mode'); return { side: 'YES', mid: 0.5 }; }
  if (sideMode === 'no')  { logger.info('[Smart] FORCE NO mode');  return { side: 'NO', mid: 0.5 };  }

  const yesTokenId = market.yesTokenId;
  let mid = 0.5;

  try {
    const result = await Promise.race([
      client.getMidpoint(yesTokenId),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]);
    mid = parseFloat(result?.mid ?? result ?? '0.5') || 0.5;
  } catch (err) {
    logger.warn(`[Smart] Midpoint failed: ${err.message} — using 0.5`);
  }

  let orderbookSide, orderbookSignal;
  if (mid < 0.48) {
    orderbookSide   = 'NO';
    orderbookSignal = `YES=${mid.toFixed(3)} (cheap) → market expects DOWN`;
  } else if (mid > 0.52) {
    orderbookSide   = 'YES';
    orderbookSignal = `YES=${mid.toFixed(3)} (expensive) → market expects UP`;
  } else {
    orderbookSide   = Math.random() < 0.5 ? 'YES' : 'NO';
    orderbookSignal = `YES=${mid.toFixed(3)} (neutral 0.48-0.52) → random ${orderbookSide}`;
  }

  const llmSide = await getLLMSide(market.question, mid, orderbookSignal);

  let extremeSide = null;
  if (mid < 0.25) {
    extremeSide = 'YES';
  } else if (mid > 0.75) {
    extremeSide = 'NO';
  }

  // [Feature 3] Reversal signal as 4th vote
  const reversalSig = getReversalSignal(mid, recentBets);

  // New signals
  const [priceActionSig, momentumSig] = await Promise.all([
    getPriceActionSignal(market),
    getMomentumSignal(),
  ]);

  logger.info(`[Smart] PriceAction=${priceActionSig ?? 'null'} Momentum=${momentumSig ?? 'null'}`);

  // Combine ALL signals
  const signals = [
    orderbookSide,
    llmSide,
    extremeSide,
    reversalSig,
    priceActionSig,
    momentumSig,
  ].filter(s => s !== null);

  const yesCount = signals.filter(s => s === 'YES').length;
  const noCount  = signals.filter(s => s === 'NO').length;

  let finalSide, reason;
  if (yesCount > noCount) {
    finalSide = 'YES';
    reason    = `${yesCount}v${noCount} majority`;
  } else if (noCount > yesCount) {
    finalSide = 'NO';
    reason    = `${noCount}v${yesCount} majority`;
  } else {
    finalSide = orderbookSide;
    reason    = `${yesCount}v${noCount} tie → orderbook`;
  }

  logger.info(`[Smart] Orderbook=${orderbookSide} LLM=${llmSide ?? 'null'} Extreme=${extremeSide ?? 'null'} Reversal=${reversalSig ?? 'null'} PriceAction=${priceActionSig ?? 'null'} Momentum=${momentumSig ?? 'null'} → ${reason} → ${finalSide}`);
  return { side: finalSide, mid, priceActionSig, momentumSig };
}

// ── Place buy ─────────────────────────────────────────────────
async function placeBuy(client, market, betSize, side) {
  const tokenId  = side === 'YES' ? market.yesTokenId : market.noTokenId;
  const tickSize = market.tickSize ?? '0.01';
  const negRisk  = market.negRisk  ?? false;

  logger.info(`[Martingale] BUY ${side} "${market.question.slice(0, 40)}" — $${betSize.toFixed(2)}`);

  if (CFG.dryRun) {
    const mockPrice  = 0.97;
    const mockShares = Math.ceil((betSize / mockPrice) * 100) / 100;
    return { fillPrice: mockPrice, shares: mockShares };
  }

  try {
    let price = 0.97;
    try {
      const book = await client.getOrderBook(tokenId);
      if (book?.asks?.length > 0) {
        price = Math.min(parseFloat(book.asks[0].price) + 0.01, 0.97);
      }
    } catch { /* use default price */ }

    const tick   = parseFloat(tickSize);
    price        = parseFloat((Math.round(price / tick) * tick).toFixed(2));
    const shares = Math.ceil((betSize / price) * 100) / 100;

    if (shares < 1) {
      logger.warn(`[Martingale] Shares too low for this market — skip`);
      return { skipped: true, reason: 'minimum_shares' };
    }

    logger.info(`[Martingale] Order: ${shares} shares @ $${price} | tickSize: ${tickSize} | negRisk: ${negRisk}`);

    const res = await Promise.race([
      client.createAndPostOrder(
        { tokenID: tokenId, side: Side.BUY, price, size: shares },
        { tickSize, negRisk },
        OrderType.GTC,
      ),
      new Promise((_, rej) => setTimeout(() => rej(new Error('createAndPostOrder timeout')), 15000)),
    ]);

    if (!res?.success) {
      const errMsg = res?.errorMsg ?? 'no fill';
      if (errMsg.toLowerCase().includes('lower than the minimum')) {
        logger.warn(`[Martingale] Order rejected — lower than minimum shares: ${errMsg}`);
        return { skipped: true, reason: 'minimum_shares' };
      }
      logger.error(`[Martingale] Buy failed: ${errMsg}`);
      return null;
    }

    const fillPrice = parseFloat(res.price ?? String(price));
    logger.success(`[Martingale] BUY filled @ $${fillPrice.toFixed(3)}`);
    return { fillPrice, shares };

  } catch (err) {
    logger.error(`[Martingale] Buy error: ${err.message}`);
    return null;
  }
}

// ── Wait for outcome ──────────────────────────────────────────
async function waitForOutcome(client, market, entryPrice, betSize, shares, side) {
  const targetPrice = entryPrice * 1.10;
  const tokenId = side === 'YES' ? market.yesTokenId : market.noTokenId;
  let earlyExitAttempted = false;

  while (true) {
    const msLeft = new Date(market.endTime).getTime() - Date.now();

    if (msLeft <= 5000) {
      logger.warn('[Martingale] Market closing — waiting for resolution');
      return { exitPrice: entryPrice, pnl: 0, pending: true };
    }

    let mid = 0;
    try {
      const result = await Promise.race([
        client.getMidpoint(tokenId),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]);
      mid = parseFloat(result?.mid ?? result ?? '0') || 0;
    } catch(e) {}

    if (!earlyExitAttempted && msLeft <= 60000 && mid > entryPrice * 1.02 && !CFG.dryRun) {
      earlyExitAttempted = true;
      try {
        logger.info(`[Martingale] Early exit! Locking profit @ $${mid.toFixed(3)}`);
        const tick      = parseFloat(market.tickSize ?? '0.01');
        const sellPrice = Math.min(
          parseFloat((Math.round(mid / tick) * tick).toFixed(2)),
          0.99,
        );
        const res = await Promise.race([
          client.createAndPostOrder(
            { tokenID: tokenId, side: Side.SELL, price: sellPrice, size: shares },
            { tickSize: market.tickSize ?? '0.01', negRisk: market.negRisk ?? false },
            OrderType.GTC,
          ),
          new Promise((_, rej) => setTimeout(() => rej(new Error('early exit timeout')), 10000)),
        ]);
        if (res?.success) {
          const exitPrice = parseFloat(res.price ?? String(sellPrice));
          const pnl       = (exitPrice - entryPrice) * shares;
          logger.success(`[Martingale] Early exit filled @ $${exitPrice.toFixed(3)} | PnL: $${pnl.toFixed(2)}`);
          return { exitPrice, pnl };
        }
        logger.warn('[Martingale] Early exit order failed — continuing to resolution');
      } catch (err) {
        logger.warn(`[Martingale] Early exit error: ${err.message} — continuing to resolution`);
      }
    }

    logger.info(`[Martingale] mid=$${mid.toFixed(3)} | target=$${targetPrice.toFixed(3)} | sisa ${Math.round(msLeft/1000)}s`);
    await new Promise(r => setTimeout(r, 10000));
  }
}

// ── [V2 L4] Apply circuit breaker after a loss ───────────────
async function applyCircuitBreaker() {
  let pauseMs    = null;
  let pauseLabel = null;
  if (consecutiveLosses === 3)      { pauseMs = 5 * 60 * 1000;      pauseLabel = '5min'; }
  else if (consecutiveLosses === 4) { pauseMs = 15 * 60 * 1000;     pauseLabel = '15min'; }
  else if (consecutiveLosses === 5) { pauseMs = 60 * 60 * 1000;     pauseLabel = '1hr'; }
  else if (consecutiveLosses >= 6)  { pauseMs = 24 * 60 * 60 * 1000; pauseLabel = '24hrs'; }

  if (pauseMs !== null) {
    pauseUntil   = Date.now() + pauseMs;
    pauseIsDaily = false;
    updateCircuitBreakerState();
    logger.warn(`[V2] Circuit breaker — ${consecutiveLosses} consecutive losses → pause ${pauseLabel}`);
    await safeNotify(() => sendMessage(
      `⏸ <b>CIRCUIT BREAKER</b>\n` +
      `Consecutive losses: ${consecutiveLosses}\n` +
      `Pausing for: ${pauseLabel}`,
    ));
  }
}

// ── [V2 L5] Check daily loss limit ───────────────────────────
async function checkDailyLossLimit() {
  if (startingBalance === null) return;
  const limit = -(startingBalance * 0.20);
  if (dailyPnl <= limit) {
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    pauseUntil   = midnight.getTime();
    pauseIsDaily = true;
    logger.warn(`[V2] Daily loss limit hit: pnl=$${dailyPnl.toFixed(2)} limit=$${limit.toFixed(2)}`);
    await safeNotify(() => sendMessage(
      `🛑 <b>DAILY LOSS LIMIT</b>\n` +
      `Lost 20% today.\n` +
      `Bot paused until 00:00 UTC`,
    ));
  }
}

// ── Handler for each new market ───────────────────────────────
async function onNewMarket(market) {
  // ── [V2 L1] Daily reset & session filter ─────────────────
  checkDailyReset();

  // ── Circuit breaker: merge memory + file, take the later pauseUntil ──
  let effectivePauseUntil = pauseUntil;
  try {
    const cb = JSON.parse(fs.readFileSync('data/circuit-breaker.json', 'utf8'));
    if (typeof cb.consecutiveLosses === 'number') consecutiveLosses = cb.consecutiveLosses;
    if (cb.pauseUntil && cb.pauseUntil > (effectivePauseUntil ?? 0)) {
      effectivePauseUntil = cb.pauseUntil;
      pauseUntil = cb.pauseUntil; // sync memory to file value
    }
  } catch { /* file may not exist yet — use in-memory defaults */ }

  if (effectivePauseUntil && Date.now() < effectivePauseUntil) {
    const remainingMin = Math.ceil((effectivePauseUntil - Date.now()) / 60000);
    logger.warn(`[Circuit] Paused — ${remainingMin}min remaining`);
    isProcessing = false;
    return;
  }

  const session = getSessionInfo();
  logger.info(`[Session] ${session.label} | Trades today: ${dailyTradeCount}/${MAX_DAILY_TRADES}`);

  if (dailyTradeCount >= MAX_DAILY_TRADES) {
    logger.warn(`[Daily] Max ${MAX_DAILY_TRADES} trades reached today — skip`);
    return;
  }

  if (isProcessing) {
    logger.warn('[Martingale] Still processing — skip');
    return;
  }

  const msLeft = new Date(market.endTime).getTime() - Date.now();
  if (msLeft < 120000) {
    logger.warn(`[Martingale] Market only ${Math.round(msLeft / 1000)}s left — skip`);
    return;
  }

  isProcessing = true;
  const client = global._martingaleClient;

  logger.info(`\n[Martingale] ══ "${market.question.slice(0, 50)}" ══`);
  logger.info(`[Martingale] Asset: ${(market.asset ?? 'BTC').toUpperCase()} | Time left: ${Math.round(msLeft / 1000)}s`);

  try {
    // Wait up to 120s for redeemer to settle any open positions
    if (getOpenPositions().length > 0) {
      logger.info('[Martingale] Waiting for previous position to settle...');
      for (let i = 0; i < 24; i++) {
        await sleep(5000);
        if (getOpenPositions().length === 0) break;
        logger.info('[Martingale] Waiting for previous position to settle...');
      }
      // If position still open after 120s, skip this round
      if (getOpenPositions().length > 0) {
        logger.warn('[Martingale] Position still open after 120s wait — skipping round');
        isProcessing = false;
        return;
      }
    }

    // Load state AFTER waiting for redeemer to settle previous round —
    // prevents reading stale step when a pending outcome was just registered.
    const state = loadMartingaleState();
    logger.info(`[Martingale] State loaded: step=${state.step}`);

    // ── [Improvement 1] Delayed entry timing ───────────────
    {
      const msLeftNow = new Date(market.endTime).getTime() - Date.now();
      if (msLeftNow > 300000) {
        const waitMs  = Math.min(60000, msLeftNow - 240000);
        const waitEnd = Date.now() + waitMs;
        while (Date.now() < waitEnd) {
          const remaining = Math.ceil((waitEnd - Date.now()) / 1000);
          logger.info(`[Entry] Waiting for orderbook to stabilize... ${remaining}s remaining`);
          await sleep(Math.min(30000, waitEnd - Date.now()));
        }
      }
    }

    // ── [V2 L2] Advanced signal + volume + spread ──────────
    const [advSignal, smartResult, volumeResult, spreadResult] = await Promise.all([
      getAdvancedSignal(activeAsset),
      getSmartSide(client, market),
      getVolumeFilter(activeAsset),
      getSpreadAnalysis(client, market),
    ]);
    const smartSide = smartResult.side;
    const marketMid = smartResult.mid;
    const priceActionSig = smartResult.priceActionSig ?? null;
    const momentumSig = smartResult.momentumSig ?? null;

    // Apply spread confidence penalty
    const adjustedConfidence = spreadResult.wide
      ? Math.max(0, advSignal.confidence - 0.1)
      : advSignal.confidence;

    // ── [Feature 4] LLM recovery signal on step >= 1 ───────
    let llmRecoverySide = null;
    if (state.step >= 1) {
      const history = state.history ?? [];
      const lastLoss = [...history].reverse().find(h => h.outcome === 'loss');
      if (lastLoss) {
        llmRecoverySide = await getLLMRecovery(lastLoss, market.question, marketMid);
        logger.info(`[Learn] Previous loss was ${lastLoss.side ?? 'unknown'}, LLM recovery suggestion: ${llmRecoverySide ?? 'null'}`);
      }
    }

    // ── [V2 L3] Confidence threshold → combine signals ─────
    const threshold = getConfidenceThreshold(session, state.step);
    let finalSide;
    if (adjustedConfidence >= threshold) {
      // Combine advanced direction + smart side + LLM recovery for final vote
      const votes = [smartSide, llmRecoverySide, advSignal.direction].filter(v => v !== null);
      const yesC = votes.filter(v => v === 'YES').length;
      const noC  = votes.filter(v => v === 'NO').length;
      if (yesC > noC)      finalSide = 'YES';
      else if (noC > yesC) finalSide = 'NO';
      else                 finalSide = smartSide; // tie → smartSide wins (more reliable)
    } else {
      finalSide = smartSide; // confidence too low → existing signals only
    }

    const betReason = `OB=${smartSide} RSI=${advSignal.rsiSig ?? 'null'} BB=${advSignal.bbSig ?? 'null'} Wick=${advSignal.wickSig ?? 'null'} PA=${priceActionSig ?? 'null'} Mom=${momentumSig ?? 'null'} → BET ${finalSide}`;
    logger.info(
      `[V2] Session=${session.label} Trades=${dailyTradeCount}/${MAX_DAILY_TRADES} | ` +
      `${betReason} | Conf=${adjustedConfidence.toFixed(2)} (min=${threshold.toFixed(2)})`,
    );

    // ── Dashboard: write signal snapshot ─────────────────
    writeDashboardData({
      lastSignal: {
        rsi:        advSignal.rsiSig   ?? null,
        bb:         advSignal.bbSig    ?? null,
        wick:       advSignal.wickSig  ?? null,
        llm:        llmRecoverySide    ?? null,
        orderbook:  smartSide,
        confidence: adjustedConfidence,
        side:       finalSide,
      },
      session:          session.label,
      betMode,
      activeAsset,
      consecutiveLosses,
      pauseUntil,
      dailyTradeCount,
      dailyPnl,
    });

    const timeWIB = market.eventStartTime
      ? new Date(market.eventStartTime).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })
      : new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });

    // ── [Feature 1 + Improvement 4] Bet size by mode ───────
    let betSize;
    if (betMode === 'flat') {
      betSize = flatBetSize;
      logger.info(`[Flat] Betting $${betSize.toFixed(2)} flat — no martingale`);
    } else if (betMode === 'kelly') {
      const hist20   = (state.history ?? []).slice(-20);
      const w20      = hist20.filter(h => h.outcome === 'win').length;
      const winRate  = hist20.length >= 20 ? w20 / hist20.length : 0.52;
      let kellyFrac  = winRate - (1 - winRate);
      kellyFrac      = Math.max(0.05, Math.min(kellyFrac, 0.25));
      let bal        = null;
      try { bal = await getUsdcBalance(); } catch { /* non-fatal */ }
      betSize = bal !== null ? bal * kellyFrac : CFG.baseSize;
      betSize = Math.max(CFG.baseSize, Math.min(betSize, 10));
      logger.info(`[Kelly] WinRate=${(winRate * 100).toFixed(0)}% Kelly=${(kellyFrac * 100).toFixed(0)}% Balance=$${(bal ?? 0).toFixed(2)} → Bet=$${betSize.toFixed(2)}`);
    } else {
      betSize = calcNextBetSize(CFG, state);
    }
    logger.info(`[Martingale] Bet: $${betSize.toFixed(2)} | Side: ${finalSide} | Step: ${state.step} | Mode: ${betMode.toUpperCase()}`);

    const buyResult = await placeBuy(client, market, betSize, finalSide);
    if (buyResult?.skipped) {
      logger.warn('[Martingale] Skipped — market minimum shares too high');
      isProcessing = false;
      return;
    }
    if (!buyResult) {
      let balance = null;
      try { balance = await getUsdcBalance(); } catch { /* non-fatal */ }
      if (balance !== null && balance < betSize) {
        const freshState = { ...state, step: 0 };
        saveMartingaleState(freshState);
        logger.warn(`[Martingale] Insufficient balance ($${balance.toFixed(2)} < $${betSize.toFixed(2)}) — reset to step 0`);
        await safeNotify(() => sendMessage(
          `⚠️ <b>INSUFFICIENT BALANCE</b>\n` +
          `Required: $${betSize.toFixed(2)}\n` +
          `Available: $${balance.toFixed(2)}\n` +
          `Resetting to step 0, bet $${CFG.baseSize.toFixed(2)}`,
        ));
      } else {
        logger.warn('[Martingale] Buy failed — skip round');
      }
      isProcessing = false;
      return;
    }

    // ── [V2 L1] Count trade ─────────────────────────────────
    dailyTradeCount++;

    // ── [Feature 3] Track recent bet directions ─────────────
    recentBets.push(finalSide);
    if (recentBets.length > 3) recentBets.shift();

    const { fillPrice, shares } = buyResult;

    // ── Dashboard: write bet data ─────────────────────────
    let _balance = null;
    try { _balance = await getUsdcBalance(); } catch { /* non-fatal */ }
    writeDashboardData({
      lastBet: {
        market: market.question,
        side:   finalSide,
        size:   betSize,
        price:  fillPrice,
        time:   new Date().toISOString(),
      },
      balance:        _balance,
      dailyTradeCount,
    });

    // ── Notify buy with full context ────────────────────────
    safeNotify(() => notifyBuy({
      market:  market.question,
      betSize,
      price:   fillPrice,
      side:    finalSide,
      mode:    betMode.toUpperCase(),
      timeWIB,
      reason:  betReason,
    }));

    if (market.conditionId) {
      const tokenId = finalSide === 'YES' ? market.yesTokenId : market.noTokenId;
      addPosition({
        conditionId: market.conditionId,
        tokenId,
        market:      market.question,
        shares,
        avgBuyPrice: fillPrice,
        totalCost:   betSize,
        outcome:     finalSide,
      });
    }

    const outcome = await waitForOutcome(client, market, fillPrice, betSize, shares, finalSide);

    if (outcome.pending) {
      logger.info('[Martingale] Outcome pending — redeemer will settle this round');
      isProcessing = false;
      return;
    }

    const { pnl } = outcome;
    const result   = pnl > 0 ? 'win' : 'loss';
    let newState = registerOutcome(CFG, state, result, pnl, market.conditionId ?? 'unknown');
    // ── [Feature 1] Flat/Kelly mode: never change step ─────
    if (betMode === 'flat' || betMode === 'kelly') {
      newState = { ...newState, step: 0, currentSize: null };
      saveMartingaleState(newState);
    }
    printSummary(newState, CFG);

    const totalPnl = (newState.history ?? []).reduce((acc, h) => acc + (h.pnl ?? 0), 0);
    const nextBet  = CFG.baseSize * Math.pow(CFG.multiplier, newState.step);

    let balance = null;
    try { balance = await getUsdcBalance(); } catch { /* non-fatal */ }

    // Read last-claim.json for txHash (set by redeemer after on-chain redemption)
    let claimTxHash = null;
    try {
      const claimData = JSON.parse(fs.readFileSync('data/last-claim.json', 'utf8'));
      claimTxHash = claimData.txHash ?? null;
      fs.unlinkSync('data/last-claim.json');
    } catch { /* file may not exist — non-fatal */ }

    if (result === 'win') {
      // ── [V2 L4] Reset circuit breaker on win ─────────────
      consecutiveLosses    = 0;
      consecutiveLossesAtMax = 0;
      updateCircuitBreakerState();
      await safeNotify(() => notifyWin({ market: market.question, pnl, step: newState.step, totalPnl, balance, txHash: claimTxHash }));
      await checkBalanceAlert();
    } else {
      // ── [V2 L4+L5] Track loss ─────────────────────────────
      consecutiveLosses++;
      dailyPnl += pnl; // pnl is negative
      updateCircuitBreakerState();

      logger.info(`[V2] Loss #${consecutiveLosses} | dailyPnl=$${dailyPnl.toFixed(2)}`);

      // Existing auto-reset at max step
      if (state.step >= CFG.maxSteps) {
        consecutiveLossesAtMax++;
        if (consecutiveLossesAtMax >= 2) {
          consecutiveLossesAtMax = 0;
          const maxBet     = CFG.baseSize * Math.pow(CFG.multiplier, CFG.maxSteps);
          const resetState = { step: 0, currentSize: null, history: newState.history };
          saveMartingaleState(resetState);
          await safeNotify(() => sendMessage(
            `🔄 <b>AUTO RESET</b>\n` +
            `Lost 2x at max step ($${maxBet.toFixed(2)})\n` +
            `Resetting to step 0, bet $${CFG.baseSize.toFixed(2)}\n` +
            `Total PnL: $${totalPnl.toFixed(2)}`,
          ));
        } else {
          await safeNotify(() => notifyLoss({ market: market.question, pnl, newStep: newState.step, nextBet, balance, totalPnl, txHash: claimTxHash }));
        }
      } else {
        consecutiveLossesAtMax = 0;
        await safeNotify(() => notifyLoss({ market: market.question, pnl, newStep: newState.step, nextBet, balance, totalPnl, txHash: claimTxHash }));
      }

      // Circuit breaker (after Telegram loss notification)
      await applyCircuitBreaker();

      // Daily loss limit check
      await checkDailyLossLimit();
    }

    // ── Dashboard: write result snapshot ─────────────────
    writeDashboardData({
      lastResult: { outcome: result, pnl, step: newState.step },
      consecutiveLosses,
      pauseUntil,
      dailyPnl,
      dailyTradeCount,
      balance,
    });

  } catch (err) {
    logger.error(`[Martingale] Error: ${err.message}`);
    await safeNotify(() => notifyError(err.message));
  } finally {
    isProcessing = false;
    if (pendingAsset) {
      activeAsset  = pendingAsset;
      pendingAsset = null;
      config.mmAssets = [activeAsset];
      logger.info(`[Martingale] Switched to ${activeAsset.toUpperCase()}`);
      await safeNotify(() => sendMessage(`🔄 Now trading ${activeAsset.toUpperCase()}`));
    }
  }
}

// ── Auto-redeem loop (runs every 60s, independent of main loop) ──
function startRedeemerLoop() {
  const intervalMs = (parseInt(process.env.REDEEM_INTERVAL ?? '60', 10)) * 1000;
  logger.info(`[Martingale] Redeemer loop started (every ${intervalMs / 1000}s)`);

  async function tick() {
    try {
      await checkAndRedeemPositions();
      await checkBalanceAlert();
    } catch (err) {
      logger.warn(`[Martingale] Redeemer error: ${err.message}`);
    }
    redeemerTimer = setTimeout(tick, intervalMs);
  }

  redeemerTimer = setTimeout(tick, intervalMs);
}

function stopRedeemerLoop() {
  if (redeemerTimer) {
    clearTimeout(redeemerTimer);
    redeemerTimer = null;
  }
}

// ── Morning briefing (07:00 WIB = 00:00 UTC) ─────────────────
async function sendMorningBriefing() {
  try {
    const s       = loadMartingaleState();
    const history = s.history ?? [];

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const h24    = history.filter(h => h.ts && new Date(h.ts).getTime() >= cutoff);

    const h24Wins   = h24.filter(h => h.outcome === 'win').length;
    const h24Losses = h24.filter(h => h.outcome === 'loss').length;
    const h24Pnl    = h24.reduce((acc, h) => acc + (h.pnl ?? 0), 0);
    const h24Rate   = h24.length > 0 ? ((h24Wins / h24.length) * 100).toFixed(1) : '0.0';

    const allWins  = history.filter(h => h.outcome === 'win').length;
    const allLoss  = history.filter(h => h.outcome === 'loss').length;
    const allPnl   = history.reduce((acc, h) => acc + (h.pnl ?? 0), 0);
    const allRate  = history.length > 0 ? ((allWins / history.length) * 100).toFixed(1) : '0.0';

    let balance = null;
    try { balance = await getUsdcBalance(); } catch { /* non-fatal */ }

    const openCount = getOpenPositions().length;
    const nextBet   = CFG.baseSize * Math.pow(CFG.multiplier, s.step);
    const sideLine  = sideMode === 'yes' ? 'FORCE YES' : sideMode === 'no' ? 'FORCE NO' : 'AUTO';
    const session   = getSessionInfo();

    const date = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric' });

    await sendMessage(
      `☀️ <b>Morning Briefing</b>\n` +
      `────────────────\n` +
      `📅 ${date}\n` +
      `────────────────\n` +
      `<b>Last 24h Activity:</b>\n` +
      `📥 Bets Placed: ${h24.length}\n` +
      `✅ Wins: ${h24Wins} | ❌ Losses: ${h24Losses}\n` +
      `📈 Win Rate: ${h24Rate}%\n` +
      `💰 PnL (24h): $${h24Pnl.toFixed(2)}\n\n` +
      `<b>All-time Performance:</b>\n` +
      `🏆 Total Trades: ${history.length}\n` +
      `📊 Win Rate: ${allRate}%\n` +
      `💵 Total PnL: $${allPnl.toFixed(2)}\n` +
      `💰 Balance: $${balance !== null ? balance.toFixed(2) : 'N/A'}\n\n` +
      `<b>Current Status:</b>\n` +
      `📂 Open Positions: ${openCount}\n` +
      `🎯 Current Step: ${s.step}/${CFG.maxSteps}\n` +
      `🤖 Asset: ${activeAsset.toUpperCase()} | Mode: ${sideLine}\n` +
      `🕐 Session: ${session.label}`,
    );
    logger.info('[Martingale] Morning briefing sent');

    // ── [Improvement 6] Auto reset daily counters ──────────
    dailyTradeCount   = 0;
    dailyPnl          = 0;
    consecutiveLosses = 0;
    pauseUntil        = null;
    pauseIsDaily      = false;
    updateCircuitBreakerState();
    logger.info('[V2] Auto reset triggered by morning briefing');
  } catch (err) {
    logger.warn(`[Martingale] Morning briefing failed: ${err.message}`);
  }
}

function startMorningBriefing() {
  let lastFiredDate = null;
  setInterval(() => {
    const now = new Date();
    if (now.getUTCHours() === 0 && now.getUTCMinutes() === 0) {
      const today = now.toISOString().slice(0, 10);
      if (lastFiredDate !== today) {
        lastFiredDate = today;
        sendMorningBriefing();
      }
    }
  }, 60 * 1000);
  logger.info('[Martingale] Morning briefing scheduler started (fires 00:00 UTC / 07:00 WIB)');
}

// ── Graceful shutdown ─────────────────────────────────────────
async function shutdown(reason = 'SIGINT') {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.warn(`[Martingale] Shutting down (${reason})`);
  await sendMessage(`🛑 <b>Bot stopped</b> (${reason})`);
  stopMMDetector();
  stopRedeemerLoop();
  stopPolling();
  process.exit(0);
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  logger.info('══════════════════════════════════════════════════');
  logger.info('  Polymarket Terminal — MARTINGALE BOT V2');
  logger.info(`  Mode     : ${CFG.dryRun ? 'DRY RUN' : 'LIVE TRADING'}`);
  logger.info(`  Asset    : ${CFG.assets.join(', ').toUpperCase()}`);
  logger.info(`  Duration : ${CFG.duration}`);
  logger.info(`  Side     : ${CFG.side}`);
  logger.info(`  Base     : $${CFG.baseSize} | x${CFG.multiplier} | max step: ${CFG.maxSteps}`);
  logger.info(`  Target   : +${CFG.targetProfitPct}%`);
  logger.info('  Commands : /status /yes /no /auto /btc /sol /eth /xrp /doge /pnl /reset /stop /martingale /flat /kelly /btc5 /btc15');
  logger.info('══════════════════════════════════════════════════');

  const client             = await initClient();
  global._martingaleClient = client;

  // ── [V2 L5] Fetch starting balance for daily loss limit ───
  try {
    startingBalance = await getUsdcBalance();
    logger.info(`[V2] Starting balance: $${startingBalance.toFixed(2)} (20% loss limit: $${(startingBalance * 0.20).toFixed(2)})`);
  } catch (err) {
    logger.warn(`[V2] Could not fetch starting balance: ${err.message}`);
  }

  // Init daily reset date
  lastResetDate = new Date().toISOString().slice(0, 10);

  const state = loadMartingaleState();
  printSummary(state, CFG);

  const session = getSessionInfo();
  logger.info(`[V2] Session: ${session.label} | maxDailyTrades=${MAX_DAILY_TRADES} | confMin=${session.confidenceMin}`);

  await startPolling(async (cmd) => {
    const s        = loadMartingaleState();
    const history  = s.history ?? [];
    const wins     = history.filter(h => h.outcome === 'win').length;
    const losses   = history.filter(h => h.outcome === 'loss').length;
    const totalPnl = history.reduce((acc, h) => acc + (h.pnl ?? 0), 0);
    const nextBet  = CFG.baseSize * Math.pow(CFG.multiplier, s.step);

    if (cmd === '/status') {
      const assetLine = pendingAsset
        ? `Asset     : ${activeAsset.toUpperCase()} → ${pendingAsset.toUpperCase()} (pending)\n`
        : `Asset     : ${activeAsset.toUpperCase()}\n`;
      const sideLine = sideMode === 'yes' ? 'FORCE YES'
                     : sideMode === 'no'  ? 'FORCE NO'
                     : 'AUTO';
      const sess     = getSessionInfo();
      const pauseLine = (pauseUntil && Date.now() < pauseUntil)
        ? `\nPaused    : ${Math.ceil((pauseUntil - Date.now()) / 60000)}min remaining`
        : '';
      // Kelly info line
      let kellyLine = '';
      if (betMode === 'kelly') {
        const hist20  = history.slice(-20);
        const w20     = hist20.filter(h => h.outcome === 'win').length;
        const winRate = hist20.length >= 20 ? w20 / hist20.length : 0.52;
        let kf        = winRate - (1 - winRate);
        kf            = Math.max(0.05, Math.min(kf, 0.25));
        kellyLine     = `\nKelly     : WinRate=${(winRate * 100).toFixed(0)}% Frac=${(kf * 100).toFixed(0)}%`;
      }
      await sendMessage(
        `<b>Martingale V2 Status</b>\n` +
        `Mode      : ${CFG.dryRun ? 'DRY RUN' : 'LIVE'}\n` +
        assetLine +
        `Duration  : ${CFG.duration}\n` +
        `Bet Mode  : ${betMode === 'flat' ? `FLAT ($${flatBetSize.toFixed(2)})` : betMode.toUpperCase()}${kellyLine}\n` +
        `Side mode : ${sideLine}\n` +
        `Step      : ${s.step} / ${CFG.maxSteps}\n` +
        `Next bet  : $${nextBet.toFixed(2)}\n` +
        `Wins      : ${wins} | Losses: ${losses}\n` +
        `Total PnL : $${totalPnl.toFixed(2)}\n` +
        `Session   : ${sess.label} | Trades: ${dailyTradeCount}/${MAX_DAILY_TRADES}\n` +
        `Daily PnL : $${dailyPnl.toFixed(2)}\n` +
        `Streak    : ${consecutiveLosses} losses` +
        pauseLine,
      );
    } else if (cmd === '/asset') {
      const msg = pendingAsset
        ? `Current: ${activeAsset.toUpperCase()} → Pending: ${pendingAsset.toUpperCase()}`
        : `Current asset: ${activeAsset.toUpperCase()}`;
      await sendMessage(msg);
    } else if (cmd === '/btc') {
      activeAsset = 'btc';
      CFG.duration = '5m';
      config.mmDuration = '5m';
      config.mmAssets = ['btc'];
      pendingAsset = null;
      stopMMDetector();
      startMMDetector(onNewMarket);
      await sendMessage('✅ Switched to BTC 5m');
    } else if (cmd === '/sol' || cmd === '/eth' || cmd === '/xrp' || cmd === '/doge') {
      const newAsset = cmd.slice(1);
      if (newAsset === activeAsset && !pendingAsset) {
        await sendMessage(`Already trading ${newAsset.toUpperCase()}`);
      } else {
        pendingAsset = newAsset;
        await sendMessage(`✅ Switching to ${newAsset.toUpperCase()} after current round`);
      }
    } else if (cmd === '/pnl') {
      const last10 = history.slice(-10);
      if (last10.length === 0) {
        await sendMessage('No trade history yet.');
      } else {
        const lines = last10.map((h, i) =>
          `${i + 1}. ${h.outcome === 'win' ? '✅' : '❌'} $${h.pnl.toFixed(2)} [step ${h.stepBefore}] ${h.ts.slice(0, 10)}`,
        );
        await sendMessage(`<b>Last ${last10.length} Trades</b>\n` + lines.join('\n'));
      }
    } else if (cmd === '/start') {
      if (!isShuttingDown) {
        await sendMessage('⚠️ Bot sudah berjalan!');
      } else {
        isShuttingDown = false;
        stopMMDetector();
        startMMDetector(onNewMarket);
        startRedeemerLoop();
        await sendMessage('✅ Bot dimulai kembali!');
        logger.info('[Martingale] Bot resumed via /start command');
      }
    } else if (cmd === '/yes') {
      sideMode = 'yes';
      await sendMessage('✅ Mode: FORCE YES — bot will always bet YES');
    } else if (cmd === '/no') {
      sideMode = 'no';
      await sendMessage('✅ Mode: FORCE NO — bot will always bet NO');
    } else if (cmd === '/auto') {
      sideMode = 'auto';
      await sendMessage('✅ Mode: AUTO — bot will use V2 signal analysis');
    } else if (cmd === '/martingale') {
      betMode = 'martingale';
      await sendMessage('✅ Bet Mode: MARTINGALE — doubles on loss');
    } else if (cmd === '/flat') {
      betMode = 'flat';
      await sendMessage('✅ Bet Mode: FLAT — always bet $1, no doubling');
    } else if (cmd === '/kelly') {
      betMode = 'kelly';
      await sendMessage('✅ Bet Mode: KELLY — dynamic sizing based on win rate');
    } else if (cmd === '/bet1') {
      flatBetSize = 1;
      await sendMessage('✅ Flat bet size: $1.00');
    } else if (cmd === '/bet2') {
      flatBetSize = 2;
      await sendMessage('✅ Flat bet size: $2.00');
    } else if (cmd === '/bet3') {
      flatBetSize = 3;
      await sendMessage('✅ Flat bet size: $3.00');
    } else if (cmd === '/bet4') {
      flatBetSize = 4;
      await sendMessage('✅ Flat bet size: $4.00');
    } else if (cmd === '/bet5') {
      flatBetSize = 5;
      await sendMessage('✅ Flat bet size: $5.00');
    } else if (cmd === '/btc15') {
      activeAsset = 'btc';
      CFG.duration = '15m';
      config.mmDuration = '15m';
      config.mmAssets = ['btc'];
      stopMMDetector();
      startMMDetector(onNewMarket);
      await sendMessage('✅ Switched to BTC 15m market');
    } else if (cmd === '/btc5') {
      CFG.duration = '5m';
      config.mmDuration = '5m';
      config.mmAssets = [activeAsset];
      stopMMDetector();
      startMMDetector(onNewMarket);
      await sendMessage('✅ Switched to BTC 5m market');
    } else if (cmd === '/reset') {
      const emptyState = { step: 0, currentSize: null, history: [] };
      fs.writeFileSync('data/martingale-state.json', JSON.stringify(emptyState, null, 2));
      fs.writeFileSync('data/positions.json', JSON.stringify({}));
      consecutiveLossesAtMax = 0;
      consecutiveLosses      = 0;
      dailyTradeCount        = 0;
      dailyPnl               = 0;
      pauseUntil             = null;
      pauseIsDaily           = false;
      updateCircuitBreakerState();
      await sendMessage('✅ State reset! Step: 0, PnL: $0.00, V2 counters cleared');
    } else if (cmd === '/stop') {
      if (isShuttingDown) {
        await sendMessage('⚠️ Bot sudah di-pause. Ketik /start untuk lanjutkan.');
        return;
      }
      isShuttingDown = true;
      stopMMDetector();
      stopRedeemerLoop();
      await sendMessage(
        '⏸ <b>Bot di-pause</b>\n' +
        '━━━━━━━━━━━━━━━━━\n' +
        '🛑 MM detector stopped\n' +
        '🛑 Redeemer stopped\n' +
        '💡 Ketik /start untuk lanjutkan\n' +
        '━━━━━━━━━━━━━━━━━'
      );
    } else if (cmd === '/redeem') {
      await sendMessage('🔍 Manually triggering checkAndRedeemPositions()...');
      try {
        const positions = getOpenPositions();
        await sendMessage(`Found ${positions.length} open position(s). Starting redemption check...`);
        await checkAndRedeemPositions();
        await sendMessage('✅ /redeem complete — check PM2 logs for details.');
      } catch (err) {
        logger.error(`[Redeemer] /redeem command error: ${err.message}`);
        await sendMessage(`❌ /redeem error: ${err.message}`);
      }

    } else if (cmd === '/dashboard') {
      const s = loadMartingaleState();
      const history = s.history ?? [];
      const wins = history.filter(h => h.outcome === 'win').length;
      const losses = history.filter(h => h.outcome === 'loss').length;
      const totalPnl = history.reduce((acc, h) => acc + (h.pnl ?? 0), 0);
      const winRate = history.length > 0 ? ((wins / history.length) * 100).toFixed(1) : '0.0';

      // Last 5 trades
      const last5 = history.slice(-5).reverse();
      let tradesLine = '';
      if (last5.length === 0) {
        tradesLine = '└ Belum ada trade\n';
      } else {
        last5.forEach((h, i) => {
          const isLast = i === last5.length - 1;
          const prefix = isLast ? '└' : '├';
          const emoji = h.outcome === 'win' ? '✅' : '❌';
          const pnlStr = h.pnl >= 0 ? '+$' + h.pnl.toFixed(2) : '-$' + Math.abs(h.pnl).toFixed(2);
          const time = h.ts ? new Date(h.ts).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }) : '??:??';
          tradesLine += `${prefix} ${emoji} ${pnlStr} | Step${h.stepBefore ?? 0} | ${time} WIB\n`;
        });
      }

      // Circuit breaker status
      let cbStatus = '🟢 OFF';
      let pauseRemaining = '';
      if (pauseUntil && Date.now() < pauseUntil) {
        const mins = Math.ceil((pauseUntil - Date.now()) / 60000);
        cbStatus = `🔴 PAUSED`;
        pauseRemaining = ` (${mins} menit lagi)`;
      }

      // Balance
      let balance = null;
      try { balance = await getUsdcBalance(); } catch {}

      const pnlEmoji = totalPnl >= 0 ? '📈' : '📉';
      const sess = getSessionInfo();

      await sendMessage(
        `📊 <b>BTC 5M PREDICTOR</b>\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `💰 Balance   : <b>$${balance !== null ? balance.toFixed(2) : 'N/A'}</b>\n` +
        `${pnlEmoji} Total PnL  : <b>${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</b>\n` +
        `🏆 Win Rate  : ${winRate}% (${wins}W/${losses}L)\n\n` +
        `📍 <b>Status</b>\n` +
        `├ Mode    : ${betMode.toUpperCase()}\n` +
        `├ Step    : ${s.step}/${CFG.maxSteps}\n` +
        `├ Session : ${sess.label}\n` +
        `├ Streak  : ${consecutiveLosses} losses\n` +
        `└ Daily   : ${dailyTradeCount}/80 trades\n\n` +
        `📋 <b>Last 5 Trades</b>\n` +
        tradesLine + '\n' +
        `⚡ Circuit Breaker: ${cbStatus}${pauseRemaining}\n` +
        `💰 Daily PnL: ${dailyPnl >= 0 ? '+' : ''}$${dailyPnl.toFixed(2)}\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `🌐 <a href="http://38.49.217.48:3000/?key=polymarket">Buka Web Dashboard</a>`,
      );

    } else if (cmd === '/help') {
      await sendMessage(
        `📖 <b>Daftar Command Bot</b>\n\n` +
        `<b>📊 Status & Info</b>\n` +
        `├ /status — Cek status bot lengkap\n` +
        `├ /pnl — Cek profit/loss\n` +
        `└ /asset — Cek asset aktif\n\n` +
        `<b>🎮 Kontrol Bot</b>\n` +
        `├ /start — Resume bot setelah stop\n` +
        `├ /stop — Hentikan bot sementara\n` +
        `└ /reset — Reset semua state &amp; PnL\n\n` +
        `<b>🎯 Pilih Arah Bet</b>\n` +
        `├ /yes — Paksa bet YES terus\n` +
        `├ /no — Paksa bet NO terus\n` +
        `└ /auto — Analisa otomatis (default)\n\n` +
        `<b>💰 Mode Bet</b>\n` +
        `├ /martingale — Double on loss\n` +
        `├ /flat — Flat bet tanpa double\n` +
        `├ /kelly — Dynamic sizing\n` +
        `└ /bet1 /bet2 /bet3 /bet4 /bet5 — Atur bet size (flat mode only)\n\n` +
        `<b>📈 Pilih Market BTC</b>\n` +
        `├ /btc — Bitcoin 5m\n` +
        `├ /btc15 — Bitcoin 15m\n` +
        `├ /sol — Solana 5m\n` +
        `├ /eth — Ethereum 5m\n` +
        `├ /xrp — XRP 5m\n` +
        `└ /doge — Dogecoin 5m\n\n` +
        `<b>🌍 Multi-Market Manual</b>\n` +
        `├ /mode btc — Mode BTC otomatis\n` +
        `├ /mode sports — Mode sports manual\n` +
        `├ /mode politics — Mode politik manual\n` +
        `├ /search &lt;keyword&gt; — Cari market\n` +
        `├ /pick &lt;nomor&gt; — Pilih market\n` +
        `├ /analyze — Analisa LLM\n` +
        `└ /bet yes|no — Eksekusi bet\n\n` +
        `<b>🔧 Tools</b>\n` +
        `├ /redeem — Claim manual\n` +
        `├ /dashboard — Ringkasan statistik + link dashboard\n` +
        `└ /help — Tampilkan pesan ini\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 Tip: /search NBA → /pick 1 → /analyze → /bet yes`
      );

    // ── Multi-market manual mode commands ─────────────────────

    } else if (cmd === '/mode btc') {
      tradingMode = 'btc';
      await sendMessage('✅ Mode: BTC 5m — bot trading otomatis seperti biasa');

    } else if (cmd === '/mode sports') {
      tradingMode = 'sports';
      await sendMessage(
        '⚽ <b>Mode: Sports</b>\n' +
        'Bot BTC tetap jalan di background.\n\n' +
        'Cara pakai:\n' +
        '🔍 /search <keyword> — cari market\n' +
        '📌 /pick <nomor> — pilih market\n' +
        '🤖 /analyze — analisa LLM\n' +
        '💰 /bet yes atau /bet no — eksekusi bet'
      );

    } else if (cmd === '/mode politics') {
      tradingMode = 'politics';
      await sendMessage(
        '🗳️ <b>Mode: Politik</b>\n' +
        'Bot BTC tetap jalan di background.\n\n' +
        'Cara pakai:\n' +
        '🔍 /search <keyword> — cari market\n' +
        '📌 /pick <nomor> — pilih market\n' +
        '🤖 /analyze — analisa LLM\n' +
        '💰 /bet yes atau /bet no — eksekusi bet'
      );

    } else if (cmd === '/search' || cmd.startsWith('/search ')) {
      const keyword = cmd.replace('/search', '').trim();
      if (!keyword) {
        await sendMessage('❌ Contoh: /search NBA Lakers');
      } else {
        await sendMessage(`🔍 Mencari market: <b>${keyword}</b>...`);
        try {
          const url = `https://gamma-api.polymarket.com/events?title=${encodeURIComponent(keyword)}&active=true&limit=5`;
          const res = await fetch(url);
          const data = await res.json();
          const events = Array.isArray(data) ? data : [];
          if (events.length === 0) {
            await sendMessage('❌ Tidak ada market ditemukan. Coba keyword lain.');
          } else {
            // Store events; /pick will extract the first market from the chosen event
            searchResults = events;
            let msg = `🔍 <b>Hasil pencarian "${keyword}":</b>\n\n`;
            events.forEach((ev, i) => {
              const m = ev.markets?.[0];
              if (!m) {
                msg += `${i+1}. ${(ev.title ?? ev.slug ?? 'Unknown').slice(0, 80)}\n   (no market data)\n\n`;
                return;
              }
              const prices = JSON.parse(m.outcomePrices ?? '["?","?"]');
              const vol = m.volume24hr ? `$${parseFloat(m.volume24hr).toFixed(0)}` : 'N/A';
              msg += `${i+1}. ${(ev.title ?? m.question ?? '').slice(0, 80)}\n`;
              msg += `   YES: $${prices[0]} | NO: $${prices[1]} | Vol: ${vol}\n\n`;
            });
            msg += '📌 Ketik /pick <nomor> untuk pilih market';
            await sendMessage(msg);
          }
        } catch (err) {
          await sendMessage(`❌ Error search: ${err.message}`);
        }
      }

    } else if (cmd === '/pick' || cmd.startsWith('/pick ')) {
      const num = parseInt(cmd.replace('/pick', '').trim());
      if (!searchResults.length) {
        await sendMessage('❌ Lakukan /search dulu ya!');
      } else if (isNaN(num) || num < 1 || num > searchResults.length) {
        await sendMessage(`❌ Pilih nomor 1-${searchResults.length}`);
      } else {
        const ev = searchResults[num - 1];
        // Events API: extract first market from the event
        const m = ev.markets?.[0] ?? ev;
        selectedMarket = {
          question:      m.question     ?? ev.title ?? ev.slug ?? 'Unknown',
          outcomePrices: m.outcomePrices ?? '["0.5","0.5"]',
          volume:        m.volume        ?? ev.volume        ?? 0,
          volume24hr:    m.volume24hr    ?? ev.volume24hr    ?? 0,
          conditionId:   m.conditionId   ?? ev.conditionId,
          clobTokenIds:  m.clobTokenIds  ?? '[]',
          endDate:       m.endDate       ?? ev.endDate,
          orderMinSize:  m.orderMinSize  ?? 5,
        };
        const prices = JSON.parse(selectedMarket.outcomePrices);
        const endDate = selectedMarket.endDate
          ? new Date(selectedMarket.endDate).toLocaleDateString('id-ID', {timeZone:'Asia/Jakarta'})
          : 'N/A';
        await sendMessage(
          `✅ <b>Market dipilih:</b>\n\n` +
          `📋 ${selectedMarket.question}\n\n` +
          `💰 YES: $${prices[0]} | NO: $${prices[1]}\n` +
          `📊 Volume: $${parseFloat(selectedMarket.volume ?? 0).toFixed(0)}\n` +
          `📅 End: ${endDate}\n\n` +
          `Ketik /analyze untuk analisa LLM\n` +
          `atau langsung /bet yes / /bet no`
        );
      }

    } else if (cmd === '/analyze') {
      if (!selectedMarket) {
        await sendMessage('❌ Pilih market dulu dengan /search dan /pick');
      } else {
        await sendMessage('🤖 Menganalisa market dengan LLM...');
        try {
          const prices = JSON.parse(selectedMarket.outcomePrices ?? '["0.5","0.5"]');
          const yesProb = (parseFloat(prices[0]) * 100).toFixed(1);
          const noProb = (parseFloat(prices[1]) * 100).toFixed(1);
          const prompt =
            `You are a prediction market analyst.\n` +
            `Market: ${selectedMarket.question}\n` +
            `YES price: $${prices[0]} (implied probability: ${yesProb}%)\n` +
            `NO price: $${prices[1]} (implied probability: ${noProb}%)\n` +
            `Volume: $${parseFloat(selectedMarket.volume ?? 0).toFixed(0)}\n` +
            `End date: ${selectedMarket.endDate}\n\n` +
            `Analyze this prediction market carefully.\n` +
            `Reply in this exact format:\n` +
            `SIDE: YES or NO\n` +
            `CONFIDENCE: X% (0-100)\n` +
            `REASON: (max 2 sentences explaining your reasoning)`;

          const apiKey = process.env.OPENROUTER_API_KEY;
          const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: LLM_MODELS[llmModelIndex % LLM_MODELS.length],
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 150,
            }),
          });
          const data = await res.json();
          const text = (data?.choices?.[0]?.message?.content ?? '').trim();
          llmRecommendation = text;

          const sideMatch = text.match(/SIDE:\s*(YES|NO)/i);
          const confMatch = text.match(/CONFIDENCE:\s*(\d+)/i);
          const reasonMatch = text.match(/REASON:\s*(.+)/is);

          const side = sideMatch ? sideMatch[1].toUpperCase() : '?';
          const conf = confMatch ? confMatch[1] : '?';
          const reason = reasonMatch ? reasonMatch[1].trim().slice(0, 200) : text;

          await sendMessage(
            `🤖 <b>Analisa LLM:</b>\n\n` +
            `📋 ${selectedMarket.question.slice(0, 80)}\n\n` +
            `🎯 Rekomendasi: <b>${side}</b>\n` +
            `💪 Confidence: <b>${conf}%</b>\n` +
            `💬 Alasan: ${reason}\n\n` +
            `Ketik /bet yes atau /bet no untuk eksekusi`
          );
        } catch (err) {
          await sendMessage(`❌ Analisa gagal: ${err.message}`);
        }
      }

    } else if (cmd === '/bet yes' || cmd === '/bet no') {
      if (!selectedMarket) {
        await sendMessage('❌ Pilih market dulu dengan /search dan /pick');
      } else {
        const betSide = cmd === '/bet yes' ? 'YES' : 'NO';
        const prices = JSON.parse(selectedMarket.outcomePrices ?? '["0.5","0.5"]');
        const price = betSide === 'YES' ? parseFloat(prices[0]) : parseFloat(prices[1]);
        const orderMinSize = selectedMarket.orderMinSize ?? 5;
        const minBet = Math.ceil(orderMinSize * price * 100) / 100;
        const betSize = Math.max(CFG.baseSize, minBet);

        await sendMessage(
          `⏳ Placing bet ${betSide} on:\n${selectedMarket.question.slice(0,60)}\nSize: $${betSize.toFixed(2)}`
        );

        try {
          const clobTokenIds = JSON.parse(selectedMarket.clobTokenIds ?? '[]');
          const marketObj = {
            question: selectedMarket.question,
            conditionId: selectedMarket.conditionId,
            yesTokenId: clobTokenIds[0],
            noTokenId: clobTokenIds[1],
            endTime: selectedMarket.endDate,
            orderMinSize: orderMinSize,
          };

          const client = global._martingaleClient;
          if (!client) throw new Error('Client not initialized');

          const result = await placeBuy(client, marketObj, betSize, betSide);
          if (result && !result.skipped) {
            const { fillPrice, shares } = result;
            if (marketObj.conditionId) {
              const tokenId = betSide === 'YES' ? marketObj.yesTokenId : marketObj.noTokenId;
              addPosition({
                conditionId: marketObj.conditionId,
                tokenId,
                market: marketObj.question,
                shares,
                avgBuyPrice: fillPrice,
                totalCost: betSize,
                outcome: betSide,
              });
            }
            await sendMessage(
              `✅ <b>BET PLACED!</b>\n\n` +
              `📋 ${selectedMarket.question.slice(0, 60)}\n` +
              `🎯 Side: ${betSide}\n` +
              `💰 Size: $${betSize.toFixed(2)}\n` +
              `📈 Price: $${fillPrice.toFixed(3)}\n` +
              `📦 Shares: ${shares}\n\n` +
              `✅ Claim akan otomatis setelah market resolve`
            );
          } else {
            await sendMessage('❌ Bet gagal — market mungkin sudah tutup atau insufficient balance');
          }
        } catch (err) {
          await sendMessage(`❌ Bet error: ${err.message}`);
        }
      }
    }
  });

  startRedeemerLoop();
  startMorningBriefing();

  logger.info('[Martingale] Checking active market...');
  await checkCurrentMarket(onNewMarket);

  logger.info('[Martingale] Waiting for next market...');
  startMMDetector(onNewMarket);

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', async (err) => {
    logger.error(`[Martingale] Uncaught: ${err.message}`);
    await safeNotify(() => notifyError(`Uncaught exception: ${err.message}`));
    process.exit(1);
  });
  process.on('unhandledRejection', async (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error(`[Martingale] Unhandled rejection: ${msg}`);
    await safeNotify(() => notifyError(`Unhandled rejection: ${msg}`));
  });
}

main().catch(async (err) => {
  logger.error(`[Martingale] Fatal: ${err.message}`);
  await safeNotify(() => notifyError(`Fatal error: ${err.message}`));
  process.exit(1);
});
