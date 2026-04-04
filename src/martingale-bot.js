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
import { addPosition } from './services/position.js';
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

const ASSET_BINANCE = { btc: 'BTCUSDT', sol: 'SOLUSDT', eth: 'ETHUSDT', xrp: 'XRPUSDT', doge: 'DOGEUSDT' };

const sleep        = (ms) => new Promise(r => setTimeout(r, ms));

async function safeNotify(fn) {
  try {
    await Promise.race([fn(), new Promise((_, r) => setTimeout(() => r(new Error('notify timeout')), 5000))]);
  } catch(e) {
    logger.warn('[Telegram] notify timeout/error: ' + e.message);
  }
}

const BALANCE_ALERT_THRESHOLD = parseFloat(process.env.BALANCE_ALERT_THRESHOLD ?? '25');
let balanceAlertFired = false; // reset when balance drops back below threshold

let isProcessing   = false;
let isShuttingDown = false;
let redeemerTimer  = null;
let consecutiveLossesAtMax = 0;

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
      balanceAlertFired = false; // reset so next crossing fires again
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
    // try extracting first word if model added extra tokens
    const match = text.match(/\b(YES|NO)\b/);
    return match ? match[1] : null;
  } catch (err) {
    logger.warn(`[AI] LLM request failed: ${err.message}`);
    return null;
  }
}

// ── Smart side selection via orderbook midpoint + LLM ────────
async function getSmartSide(client, market) {
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

  let orderbookSide;
  let orderbookSignal;
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

  let finalSide;
  if (!llmSide) {
    finalSide = orderbookSide;
    logger.info(`[AI] LLM failed → BET ${finalSide} (orderbook fallback)`);
  } else if (llmSide === orderbookSide) {
    finalSide = llmSide;
    logger.info(`[AI] LLM=${llmSide} Orderbook=${orderbookSide} → agree → BET ${finalSide}`);
  } else {
    finalSide = orderbookSide;
    logger.info(`[AI] LLM=${llmSide} Orderbook=${orderbookSide} → disagree → BET ${finalSide} (orderbook wins)`);
  }

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
      logger.error(`[Martingale] Shares too small: ${shares}`);
      return null;
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
      logger.error(`[Martingale] Buy failed: ${res?.errorMsg ?? 'no fill'}`);
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
// Runs a blocking monitoring loop every 10s until market closes.
// Returns { exitPrice, pnl } or { exitPrice, pnl: 0, pending: true } when
// market is closing and resolution will be handled by the redeemer.
async function waitForOutcome(client, market, entryPrice, betSize, shares, side) {
  const targetPrice = entryPrice * 1.10;
  const tokenId = side === 'YES' ? market.yesTokenId : market.noTokenId;

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

    logger.info(`[Martingale] mid=$${mid.toFixed(3)} | target=$${targetPrice.toFixed(3)} | sisa ${Math.round(msLeft/1000)}s`);

    await new Promise(r => setTimeout(r, 10000));
  }
}

// ── Handler for each new market ───────────────────────────────
async function onNewMarket(market) {
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
    const side    = await getSmartSide(client, market);
    const betSize = calcNextBetSize(CFG, state);
    logger.info(`[Martingale] Bet: $${betSize.toFixed(2)} | Side: ${side}`);

    const result = await placeBuy(client, market, betSize, side);
    if (!result) {
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

    const { fillPrice, shares } = result;

    // Record position so the redeemer can auto-claim USDC after resolution
    if (market.conditionId) {
      const tokenId = side === 'YES' ? market.yesTokenId : market.noTokenId;
      addPosition({
        conditionId: market.conditionId,
        tokenId,
        market:      market.question,
        shares,
        avgBuyPrice: fillPrice,
        totalCost:   betSize,
        outcome:     side,
      });
    }

    // Block here — monitoring loop runs until market closes
    const outcome = await waitForOutcome(client, market, fillPrice, betSize, shares, side);

    if (outcome.pending) {
      // Market closed — redeemer will handle WIN/LOSS via checkAndRedeemPositions
      logger.info('[Martingale] Outcome pending — redeemer will settle this round');
      isProcessing = false;
      return;
    } else {
      const { pnl } = outcome;
      // Register outcome and update martingale step
      const result   = pnl > 0 ? 'win' : 'loss';
      const newState = registerOutcome(CFG, state, result, pnl, market.conditionId ?? 'unknown');
      printSummary(newState, CFG);

      const totalPnl = (newState.history ?? []).reduce((acc, h) => acc + (h.pnl ?? 0), 0);
      const nextBet  = CFG.baseSize * Math.pow(CFG.multiplier, newState.step);

      let balance = null;
      try { balance = await getUsdcBalance(); } catch { /* non-fatal */ }
      if (result === 'win') {
        consecutiveLossesAtMax = 0;
        await safeNotify(() => notifyWin({ market: market.question, pnl, step: newState.step, totalPnl, balance }));
        await checkBalanceAlert();
      } else {
        if (state.step >= CFG.maxSteps) {
          consecutiveLossesAtMax++;
          if (consecutiveLossesAtMax >= 2) {
            consecutiveLossesAtMax = 0;
            const maxBet    = CFG.baseSize * Math.pow(CFG.multiplier, CFG.maxSteps);
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
      }
    }

  } catch (err) {
    logger.error(`[Martingale] Error: ${err.message}`);
    await safeNotify(() => notifyError(err.message));
  } finally {
    isProcessing = false;
    if (pendingAsset) {
      activeAsset = pendingAsset;
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
  logger.info('  Polymarket Terminal — MARTINGALE BOT');
  logger.info(`  Mode     : ${CFG.dryRun ? 'DRY RUN' : 'LIVE TRADING'}`);
  logger.info(`  Asset    : ${CFG.assets.join(', ').toUpperCase()}`);
  logger.info(`  Duration : ${CFG.duration}`);
  logger.info(`  Side     : ${CFG.side}`);
  logger.info(`  Base     : $${CFG.baseSize} | x${CFG.multiplier} | max step: ${CFG.maxSteps}`);
  logger.info(`  Target   : +${CFG.targetProfitPct}%`);
  logger.info('══════════════════════════════════════════════════');

  const client             = await initClient();
  global._martingaleClient = client;

  const state = loadMartingaleState();
  printSummary(state, CFG);

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
      await sendMessage(
        `<b>Martingale Status</b>\n` +
        `Mode      : ${CFG.dryRun ? 'DRY RUN' : 'LIVE'}\n` +
        assetLine +
        `Step      : ${s.step} / ${CFG.maxSteps}\n` +
        `Next bet  : $${nextBet.toFixed(2)}\n` +
        `Wins      : ${wins} | Losses: ${losses}\n` +
        `Total PnL : $${totalPnl.toFixed(2)}`,
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
    } else if (cmd === '/reset') {
      const emptyState = { step: 0, currentSize: null, history: [] };
      fs.writeFileSync('data/martingale-state.json', JSON.stringify(emptyState, null, 2));
      fs.writeFileSync('data/positions.json', JSON.stringify({}));
      consecutiveLossesAtMax = 0;
      await sendMessage('✅ State reset! Step: 0, PnL: $0.00');
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
