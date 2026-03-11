/**
 * sniper-tui.js
 * TUI version of the Orderbook Sniper bot (blessed dashboard).
 * Places tiny GTC BUY orders at a low price on both sides of 5-min markets.
 *
 * Run with: npm run sniper-tui       (live)
 *           npm run sniper-tui-sim   (simulation)
 */

// Load proxy patch BEFORE any other imports (must patch https before axios is loaded)
import './utils/proxy-patch.cjs';

import { validateMMConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient } from './services/client.js';
import { getUsdcBalance } from './services/client.js';
import { initDashboard, appendLog, updateStatus, isDashboardActive } from './ui/dashboard.js';
import { startSniperDetector, stopSniperDetector } from './services/sniperDetector.js';
import { executeSnipe, getActiveSnipes, getConditionAsset } from './services/sniperExecutor.js';
import { redeemSniperPositions, onSniperWin } from './services/ctf.js';
import { getSchedule, isAssetInSession, getNextSessionInfo } from './services/schedule.js';
import { getTimeMultiplier } from './services/sniperSizing.js';

// ── Validate config ────────────────────────────────────────────────────────────

try {
    validateMMConfig();
} catch (err) {
    console.error(`Config error: ${err.message}`);
    process.exit(1);
}

if (config.sniperAssets.length === 0) {
    console.error('SNIPER_ASSETS is empty. Set e.g. SNIPER_ASSETS=eth,sol,xrp in .env');
    process.exit(1);
}

// ── Init TUI ──────────────────────────────────────────────────────────────────

initDashboard();
logger.setOutput(appendLog);

// ── Init CLOB client ──────────────────────────────────────────────────────────

try {
    await initClient();
} catch (err) {
    logger.error(`Client init error: ${err.message}`);
    process.exit(1);
}

// ── Status panel ──────────────────────────────────────────────────────────────

async function buildStatusContent() {
    const lines = [];

    // Balance
    let balance = '?';
    if (!config.dryRun) {
        try { balance = (await getUsdcBalance()).toFixed(2); } catch { /* ignore */ }
    } else {
        balance = '{yellow-fg}SIM{/yellow-fg}';
    }
    lines.push('{bold}BALANCE{/bold}');
    lines.push(`  USDC.e: {green-fg}$${balance}{/green-fg}`);
    lines.push('');

    lines.push('{bold}MODE{/bold}');
    lines.push(`  ${config.dryRun ? '{yellow-fg}SIMULATION{/yellow-fg}' : '{green-fg}LIVE{/green-fg}'}`);
    lines.push('');

    lines.push('{bold}SNIPER CONFIG{/bold}');
    const prices = config.sniperTierPrices;
    const sizes = [Math.floor(config.sniperMaxShares * 0.20), Math.floor(config.sniperMaxShares * 0.30), Math.floor(config.sniperMaxShares * 0.50)];
    lines.push(`  Assets : ${config.sniperAssets.join(', ').toUpperCase()}`);
    lines.push(`  3-Tier : ${prices[0]}c/${prices[1]}c/${prices[2]}c`);
    lines.push(`  Sizes  : ${sizes[0]}/${sizes[1]}/${sizes[2]} shares`);
    const costPerSide = (sizes[0] * prices[0]) + (sizes[1] * prices[1]) + (sizes[2] * prices[2]);
    lines.push(`  Cost   : $${(costPerSide * 2 * config.sniperAssets.length).toFixed(3)} per slot (base)`);
    const { multiplier, label: mulLabel } = getTimeMultiplier();
    if (config.sniperMultipliers.length > 0) {
        lines.push(`  Mul    : ${mulLabel}`);
    }
    if (config.sniperPauseRoundsAfterWin > 0) {
        lines.push(`  Pause  : ${config.sniperPauseRoundsAfterWin} rounds after win`);
    }
    // Show per-asset pause status
    for (const a of config.sniperAssets) {
        if (pauseCounters[a] > 0) {
            lines.push(`  {yellow-fg}${a.toUpperCase()} paused (${pauseCounters[a]} rounds){/yellow-fg}`);
        }
    }
    lines.push('');

    // Session schedule
    lines.push('{bold}SESSION SCHEDULE (UTC+8){/bold}');
    const schedule = getSchedule();
    for (const asset of config.sniperAssets) {
        const sessions = schedule[asset];
        const active = isAssetInSession(asset);
        const statusTag = active
            ? '{green-fg}● ACTIVE{/green-fg}'
            : '{red-fg}○ IDLE{/red-fg}';
        if (sessions) {
            const sessionStr = sessions.map(s => `${s.startUtc8}–${s.endUtc8}`).join(', ');
            lines.push(`  ${asset.toUpperCase()} ${statusTag}  ${sessionStr}`);
            if (!active) {
                const next = getNextSessionInfo(asset);
                if (next) lines.push(`    {gray-fg}Next in ${next}{/gray-fg}`);
            }
        } else {
            lines.push(`  ${asset.toUpperCase()} {yellow-fg}NO SCHEDULE{/yellow-fg} (always active)`);
        }
    }
    lines.push('');

    // Recent snipe orders
    const snipes = getActiveSnipes();
    lines.push(`{bold}SNIPE ORDERS (${snipes.length} total){/bold}`);

    if (snipes.length === 0) {
        lines.push('  {gray-fg}Waiting for next slot...{/gray-fg}');
    } else {
        // Show last 10 orders (most recent first)
        const recent = snipes.slice(-10).reverse();
        for (const s of recent) {
            const payout = s.potentialPayout.toFixed(2);
            lines.push(`  {cyan-fg}${s.asset}{/cyan-fg} ${s.side} @ $${s.price} × ${s.shares}sh | pay $${payout} if win`);
        }
    }

    return '\n' + lines.join('\n');
}

let refreshTimer = null;
let redeemTimer = null;

function startRefresh() {
    refreshTimer = setInterval(async () => {
        if (!isDashboardActive()) return;
        updateStatus(await buildStatusContent());
    }, 3000);
    buildStatusContent().then(updateStatus);
}

function startRedeemer() {
    redeemSniperPositions().catch((err) => logger.error('Sniper redeemer error:', err.message));
    redeemTimer = setInterval(
        () => redeemSniperPositions().catch((err) => logger.error('Sniper redeemer error:', err.message)),
        config.redeemInterval,
    );
    logger.info(`Sniper redeemer started — checking every ${config.redeemInterval / 1000}s`);
}

// ── Pause-after-win tracking ─────────────────────────────────────────────────

const pauseCounters = {};

function handleWin(conditionId) {
    const asset = getConditionAsset(conditionId);
    if (!asset) return;
    const rounds = config.sniperPauseRoundsAfterWin;
    pauseCounters[asset] = rounds;
    logger.success(`SNIPER: WIN on ${asset.toUpperCase()} — pausing ${rounds} rounds`);
}

function isAssetPaused(asset) {
    const key = asset.toLowerCase();
    return pauseCounters[key] > 0;
}

function tickPause(asset) {
    const key = asset.toLowerCase();
    if (pauseCounters[key] > 0) {
        pauseCounters[key]--;
        if (pauseCounters[key] <= 0) {
            logger.info(`SNIPER: ${asset.toUpperCase()} pause ended — resuming`);
        }
    }
}

onSniperWin(handleWin);

// ── Market handler ────────────────────────────────────────────────────────────

async function handleNewMarket(market) {
    const asset = market.asset.toLowerCase();

    tickPause(asset);

    if (isAssetPaused(asset)) {
        logger.info(`SNIPER: ${asset.toUpperCase()} paused (${pauseCounters[asset]} rounds left) — skipping`);
        return;
    }

    executeSnipe(market).catch((err) =>
        logger.error(`SNIPER execute error (${market.asset}): ${err.message}`)
    );
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown() {
    logger.warn('SNIPER: shutting down...');
    stopSniperDetector();
    if (refreshTimer) clearInterval(refreshTimer);
    if (redeemTimer) clearInterval(redeemTimer);
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────

const prices = config.sniperTierPrices;
const sizes = [Math.floor(config.sniperMaxShares * 0.20), Math.floor(config.sniperMaxShares * 0.30), Math.floor(config.sniperMaxShares * 0.50)];
const costPerSide = (sizes[0] * prices[0]) + (sizes[1] * prices[1]) + (sizes[2] * prices[2]);
const costPerSlot = (costPerSide * 2 * config.sniperAssets.length).toFixed(3);
logger.info(`SNIPER starting — ${config.dryRun ? 'SIMULATION' : 'LIVE'}`);
logger.info(`Assets: ${config.sniperAssets.join(', ').toUpperCase()} | 3-tier: 3c×${sizes[0]}+2c×${sizes[1]}+1c×${sizes[2]} = $${costPerSlot}/slot`);

startRefresh();
startRedeemer();
startSniperDetector(handleNewMarket);
