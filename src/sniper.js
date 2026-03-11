/**
 * sniper.js
 * Console-only entry point for the Orderbook Sniper bot.
 * Places tiny GTC BUY orders at a low price on both sides of 5-min markets.
 *
 * Features:
 *   - Time-based multiplier sizing (SNIPER_MULTIPLIERS, UTC+8)
 *   - Pause N rounds per asset after a win (SNIPER_PAUSE_ROUNDS_AFTER_WIN)
 *   - Win detection via outcome (payoutNumerators), not redeem value
 *
 * Run with: npm run sniper       (live, console)
 *           npm run sniper-sim   (simulation, console)
 *
 * For the TUI dashboard version, use: npm run sniper-tui
 */

import { validateMMConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient } from './services/client.js';
import { startSniperDetector, stopSniperDetector } from './services/sniperDetector.js';
import { executeSnipe, getConditionAsset } from './services/sniperExecutor.js';
import { redeemSniperPositions, onSniperWin } from './services/ctf.js';
import { getSchedule, isAssetInSession, getNextSessionInfo } from './services/schedule.js';
import { getTimeMultiplier } from './services/sniperSizing.js';

// Set proxy before any network calls
import './utils/proxy-patch.cjs';

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

// ── Init CLOB client ──────────────────────────────────────────────────────────

try {
    await initClient();
} catch (err) {
    logger.error(`Client init error: ${err.message}`);
    process.exit(1);
}

// ── Pause-after-win tracking ─────────────────────────────────────────────────

// pauseCounters[asset] = number of rounds remaining to skip
const pauseCounters = {};

/**
 * Called by the redeemer when a win is detected.
 * Looks up the asset from the conditionId mapping and sets the pause counter.
 */
function handleWin(conditionId) {
    const asset = getConditionAsset(conditionId);
    if (!asset) {
        logger.info(`SNIPER: win detected for ${conditionId.slice(0, 12)}... but no asset mapping found`);
        return;
    }
    const rounds = config.sniperPauseRoundsAfterWin;
    pauseCounters[asset] = rounds;
    logger.success(`SNIPER: WIN on ${asset.toUpperCase()} — pausing ${rounds} rounds`);
}

/**
 * Check if an asset is currently paused due to a recent win.
 * Each call with decrement=true counts as one round passing.
 */
function isAssetPaused(asset) {
    const key = asset.toLowerCase();
    if (!pauseCounters[key] || pauseCounters[key] <= 0) return false;
    return true;
}

/**
 * Decrement pause counter for an asset (called once per round/slot).
 */
function tickPause(asset) {
    const key = asset.toLowerCase();
    if (pauseCounters[key] && pauseCounters[key] > 0) {
        pauseCounters[key]--;
        if (pauseCounters[key] <= 0) {
            logger.info(`SNIPER: ${asset.toUpperCase()} pause ended — resuming`);
        }
    }
}

// Register win callback
onSniperWin(handleWin);

// ── Log session schedule ──────────────────────────────────────────────────────

function logSchedule() {
    const schedule = getSchedule();
    logger.info('─── Session Schedule (UTC+8) ───');
    for (const asset of config.sniperAssets) {
        const sessions = schedule[asset];
        const active = isAssetInSession(asset);
        const status = active ? '● ACTIVE' : '○ IDLE';
        if (sessions) {
            const sessionStr = sessions.map(s => `${s.startUtc8}–${s.endUtc8}`).join(', ');
            logger.info(`  ${asset.toUpperCase()} [${status}]  ${sessionStr}`);
            if (!active) {
                const next = getNextSessionInfo(asset);
                if (next) logger.info(`    → Next in ${next}`);
            }
        } else {
            logger.info(`  ${asset.toUpperCase()} [NO SCHEDULE] (always active)`);
        }
    }
    logger.info('────────────────────────────────');
}

// ── Redeemer ──────────────────────────────────────────────────────────────────

let redeemTimer = null;

function startRedeemer() {
    // Only run on interval, NOT on startup (we only want to redeem NEW winning positions)
    redeemTimer = setInterval(
        () => redeemSniperPositions().catch((err) => logger.error('Sniper redeemer error:', err.message)),
        config.redeemInterval,
    );
    logger.info(`Sniper redeemer started — checking every ${config.redeemInterval / 1000}s (winners only, no startup check)`);
}

// ── Market handler ────────────────────────────────────────────────────────────

async function handleNewMarket(market) {
    const asset = market.asset.toLowerCase();

    // Tick pause counter for this asset (each new market = 1 round)
    tickPause(asset);

    // Check if asset is paused after a recent win
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
    if (redeemTimer) clearInterval(redeemTimer);
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────

// Calculate cost for 3-tier strategy
const prices = config.sniperTierPrices;
const sizes = [Math.floor(config.sniperMaxShares * 0.20), Math.floor(config.sniperMaxShares * 0.30), Math.floor(config.sniperMaxShares * 0.50)];
const costPerSide = (sizes[0] * prices[0]) + (sizes[1] * prices[1]) + (sizes[2] * prices[2]);
const costPerSlot = (costPerSide * 2 * config.sniperAssets.length).toFixed(3);
logger.info(`SNIPER starting — ${config.dryRun ? 'SIMULATION' : 'LIVE'}`);
logger.info(`Assets: ${config.sniperAssets.join(', ').toUpperCase()} | 3-tier: 3c×${sizes[0]}+2c×${sizes[1]}+1c×${sizes[2]} = $${costPerSlot}/slot (base)`);

// Log multiplier config
if (config.sniperMultipliers.length > 0) {
    logger.info('─── Sizing Multipliers (UTC+8) ───');
    for (const w of config.sniperMultipliers) {
        logger.info(`  ${w.start}–${w.end} → ${w.multiplier}x`);
    }
    const { multiplier, label } = getTimeMultiplier();
    logger.info(`  Current: ${label}`);
    logger.info('──────────────────────────────────');
}

if (config.sniperPauseRoundsAfterWin > 0) {
    logger.info(`Pause after win: ${config.sniperPauseRoundsAfterWin} rounds per asset`);
}

logSchedule();
startRedeemer();
startSniperDetector(handleNewMarket);
