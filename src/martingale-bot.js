import 'dotenv/config';
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

// ── Smart side selection via Binance ──────────────────────────
async function getSmartSide() {
  const THRESHOLD = 0.02; // % change to count as directional

  function getTrend(candles) {
    const prev = parseFloat(candles[candles.length - 2][4]);
    const last = parseFloat(candles[candles.length - 1][4]);
    const changePct = ((last - prev) / prev) * 100;
    if (changePct > THRESHOLD)  return 'UP';
    if (changePct < -THRESHOLD) return 'DOWN';
    return 'FLAT';
  }

  try {
    const symbol = ASSET_BINANCE[activeAsset] ?? 'BTCUSDT';
    const base = `https://api.binance.com/api/v3/klines?symbol=${symbol}&limit=3&interval=`;
    const [r1, r3, r5] = await Promise.all([
      fetch(base + '1m'),
      fetch(base + '3m'),
      fetch(base + '5m'),
    ]);
    if (!r1.ok || !r3.ok || !r5.ok) throw new Error(`HTTP ${r1.status}/${r3.status}/${r5.status}`);

    const [c1, c3, c5] = await Promise.all([r1.json(), r3.json(), r5.json()]);
    const t1 = getTrend(c1);
    const t3 = getTrend(c3);
    const t5 = getTrend(c5);

    const ups   = [t1, t3, t5].filter(t => t === 'UP').length;
    const downs = [t1, t3, t5].filter(t => t === 'DOWN').length;

    let side;
    let reason;

    if (downs > ups) {
      side   = 'NO';
      reason = `${downs} DOWN > ${ups} UP → majority`;
    } else if (ups > downs) {
      side   = 'YES';
      reason = `${ups} UP > ${downs} DOWN → majority`;
    } else if (t5 !== 'FLAT') {
      side   = t5 === 'UP' ? 'YES' : 'NO';
      reason = `tied ${ups}v${downs} → 5m tiebreaker`;
    } else {
      side   = CFG.side;
      reason = `tied ${ups}v${downs} → 5m flat → default`;
    }

    logger.info(`[Smart] 1m=${t1} 3m=${t3} 5m=${t5} → ${reason} → BET ${side}`);
    return side;

  } catch (err) {
    logger.warn(`[Smart] Binance fetch failed: ${err.message} — using ${CFG.side}`);
    return CFG.side;
  }
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
    const side    = await getSmartSide();
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
        await safeNotify(() => notifyWin({ market: market.question, pnl, step: newState.step, totalPnl, balance }));
        await checkBalanceAlert();
      } else {
        await safeNotify(() => notifyLoss({ market: market.question, pnl, newStep: newState.step, nextBet, balance }));
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
    } else if (cmd === '/stop') {
      if (isShuttingDown) return;
      isShuttingDown = true;
      await sendMessage('🛑 Stopping bot gracefully...');
      stopMMDetector();
      stopRedeemerLoop();
      stopPolling();
      const { exec } = await import('child_process');
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
