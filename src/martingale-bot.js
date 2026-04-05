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
  }
}

// ── [V2 L1] Session info ──────────────────────────────────────
function getSessionInfo() {
  const h = new Date().getUTCHours();
  if (h >= 1 && h < 7)  return { label: 'PRIME',      maxTrades: 50, confidenceMin: 0.55 };
  if (h >= 7 && h < 13) return { label: 'OKAY',       maxTrades: 15, confidenceMin: 0.65 };
  return                       { label: 'RESTRICTED', maxTrades: 10, confidenceMin: 0.75 };
}

// ── [V2 L3] Confidence threshold by session + step ────────────
function getConfidenceThreshold(session, step) {
  if (step === 0) return session.confidenceMin;
  // Recovery steps (step >= 1) require higher confidence
  const recovery = { PRIME: 0.70, OKAY: 0.75, RESTRICTED: 0.80 };
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
      direction  = Math.random() < 0.5 ? 'YES' : 'NO';
      confidence = 0.33;
    }

    return { direction, confidence, rsiSig, bbSig, wickSig };
  } catch (err) {
    logger.warn(`[V2] Advanced signal error: ${err.message} — using random fallback`);
    return {
      direction:  Math.random() < 0.5 ? 'YES' : 'NO',
      confidence: 0.33,
      rsiSig:     null,
      bbSig:      null,
      wickSig:    null,
    };
  }
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
    const res = await Promise.race([
      fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'qwen/qwen3.6-plus:free',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 5,
        }),
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('LLM timeout')), 5000)),
    ]);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = (data?.choices?.[0]?.message?.content ?? '').trim().toUpperCase();
    if (text === 'YES' || text === 'NO') return text;
    const match = text.match(/\b(YES|NO)\b/);
    return match ? match[1] : null;
  } catch (err) {
    logger.warn(`[AI] LLM request failed: ${err.message}`);
    return null;
  }
}

// ── Smart side selection via orderbook midpoint + LLM ────────
async function getSmartSide(client, market) {
  if (sideMode === 'yes') { logger.info('[Smart] FORCE YES mode'); return 'YES'; }
  if (sideMode === 'no')  { logger.info('[Smart] FORCE NO mode');  return 'NO';  }

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

  const signals  = [orderbookSide, llmSide, extremeSide].filter(s => s !== null);
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

  logger.info(`[Smart] Orderbook=${orderbookSide} LLM=${llmSide ?? 'null'} Extreme=${extremeSide ?? 'null'} → ${reason} → ${finalSide}`);
  return finalSide;
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
    safeNotify(() => notifyBuy({ market: market.question, betSize, price: fillPrice, side }));
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
  const session = getSessionInfo();
  logger.info(`[Session] ${session.label} | Trades today: ${dailyTradeCount}/${session.maxTrades}`);

  if (dailyTradeCount >= session.maxTrades) {
    logger.warn(`[Session] ${session.label} trade limit reached (${dailyTradeCount}/${session.maxTrades}) — skip`);
    return;
  }

  // ── [V2 L4] Circuit breaker pause check ──────────────────
  if (pauseUntil && Date.now() < pauseUntil) {
    const remainingMin = Math.ceil((pauseUntil - Date.now()) / 60000);
    logger.warn(`[V2] Circuit breaker active — ${remainingMin}min remaining`);
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
  const state  = loadMartingaleState();

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
    }

    // ── [V2 L2] Advanced signal (RSI + BB + Wick) ──────────
    const [advSignal, smartSide] = await Promise.all([
      getAdvancedSignal(activeAsset),
      getSmartSide(client, market),
    ]);

    // ── [V2 L3] Confidence threshold → combine signals ─────
    const threshold = getConfidenceThreshold(session, state.step);
    let finalSide;
    if (advSignal.confidence >= threshold) {
      // Combine advanced direction + smart side for final vote
      const yesC = [advSignal.direction, smartSide].filter(v => v === 'YES').length;
      const noC  = [advSignal.direction, smartSide].filter(v => v === 'NO').length;
      if (yesC > noC)      finalSide = 'YES';
      else if (noC > yesC) finalSide = 'NO';
      else                 finalSide = advSignal.direction; // tie → advanced wins
    } else {
      finalSide = smartSide; // confidence too low → existing signals only
    }

    logger.info(
      `[V2] Session=${session.label} Trades=${dailyTradeCount}/${session.maxTrades} | ` +
      `RSI=${advSignal.rsiSig ?? 'null'} BB=${advSignal.bbSig ?? 'null'} Wick=${advSignal.wickSig ?? 'null'} | ` +
      `Conf=${advSignal.confidence.toFixed(2)} (min=${threshold.toFixed(2)}) → BET ${finalSide}`,
    );

    const betSize = calcNextBetSize(CFG, state);
    logger.info(`[Martingale] Bet: $${betSize.toFixed(2)} | Side: ${finalSide} | Step: ${state.step}`);

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

    const { fillPrice, shares } = buyResult;

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
    const newState = registerOutcome(CFG, state, result, pnl, market.conditionId ?? 'unknown');
    printSummary(newState, CFG);

    const totalPnl = (newState.history ?? []).reduce((acc, h) => acc + (h.pnl ?? 0), 0);
    const nextBet  = CFG.baseSize * Math.pow(CFG.multiplier, newState.step);

    let balance = null;
    try { balance = await getUsdcBalance(); } catch { /* non-fatal */ }

    if (result === 'win') {
      // ── [V2 L4] Reset circuit breaker on win ─────────────
      consecutiveLosses    = 0;
      consecutiveLossesAtMax = 0;
      await safeNotify(() => notifyWin({ market: market.question, pnl, step: newState.step, totalPnl, balance }));
      await checkBalanceAlert();
    } else {
      // ── [V2 L4+L5] Track loss ─────────────────────────────
      consecutiveLosses++;
      dailyPnl += pnl; // pnl is negative

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
          await safeNotify(() => notifyLoss({ market: market.question, pnl, newStep: newState.step, nextBet, balance }));
        }
      } else {
        consecutiveLossesAtMax = 0;
        await safeNotify(() => notifyLoss({ market: market.question, pnl, newStep: newState.step, nextBet, balance }));
      }

      // Circuit breaker (after Telegram loss notification)
      await applyCircuitBreaker();

      // Daily loss limit check
      await checkDailyLossLimit();
    }

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
  logger.info('  Commands : /status /yes /no /auto /btc /sol /eth /xrp /doge /pnl /reset /stop');
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
  logger.info(`[V2] Session: ${session.label} | maxTrades=${session.maxTrades} | confMin=${session.confidenceMin}`);

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
      await sendMessage(
        `<b>Martingale V2 Status</b>\n` +
        `Mode      : ${CFG.dryRun ? 'DRY RUN' : 'LIVE'}\n` +
        assetLine +
        `Side mode : ${sideLine}\n` +
        `Step      : ${s.step} / ${CFG.maxSteps}\n` +
        `Next bet  : $${nextBet.toFixed(2)}\n` +
        `Wins      : ${wins} | Losses: ${losses}\n` +
        `Total PnL : $${totalPnl.toFixed(2)}\n` +
        `Session   : ${sess.label} | Trades: ${dailyTradeCount}/${sess.maxTrades}\n` +
        `Daily PnL : $${dailyPnl.toFixed(2)}\n` +
        `Streak    : ${consecutiveLosses} losses` +
        pauseLine,
      );
    } else if (cmd === '/asset') {
      const msg = pendingAsset
        ? `Current: ${activeAsset.toUpperCase()} → Pending: ${pendingAsset.toUpperCase()}`
        : `Current asset: ${activeAsset.toUpperCase()}`;
      await sendMessage(msg);
    } else if (cmd === '/btc' || cmd === '/sol' || cmd === '/eth' || cmd === '/xrp' || cmd === '/doge') {
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
      exec('pm2 jlist', (err, stdout) => {
        try {
          const procs = JSON.parse(stdout || '[]');
          const proc  = procs.find(p => (p.name ?? p.pm2_env?.name) === 'martingale-bot');
          if (proc && proc.pm2_env?.status === 'online') {
            sendMessage('⚠️ Bot is already running');
          } else {
            exec('pm2 start martingale-bot', (err2) => {
              if (err2) {
                sendMessage(`❌ Failed to start: ${err2.message}`);
              } else {
                sendMessage('✅ Bot started successfully');
              }
            });
          }
        } catch (e) {
          sendMessage(`❌ Failed: ${e.message}`);
        }
      });
    } else if (cmd === '/yes') {
      sideMode = 'yes';
      await sendMessage('✅ Mode: FORCE YES — bot will always bet YES');
    } else if (cmd === '/no') {
      sideMode = 'no';
      await sendMessage('✅ Mode: FORCE NO — bot will always bet NO');
    } else if (cmd === '/auto') {
      sideMode = 'auto';
      await sendMessage('✅ Mode: AUTO — bot will use V2 signal analysis');
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
      await sendMessage('✅ State reset! Step: 0, PnL: $0.00, V2 counters cleared');
    } else if (cmd === '/stop') {
      if (isShuttingDown) return;
      isShuttingDown = true;
      await sendMessage('🛑 Stopping bot gracefully...');
      stopMMDetector();
      stopRedeemerLoop();
      stopPolling();
      const pmTarget = process.env.name ?? process.env.pm_id ?? 'martingale-bot';
      exec(`pm2 stop ${pmTarget}`, () => process.exit(0));
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
