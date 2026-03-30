/**
 * maker-mm-bot.js — Maker Rebate MM, PM2 / VPS entry point (no TUI)
 *
 * Plain-text stdout output, compatible with:
 *   pm2 start pm2/maker-mm.config.cjs
 *   pm2 logs polymarket-maker-mm
 */

// Set proxy before any network calls
import './utils/proxy-patch.cjs';

import { validateMakerMMConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient, getUsdcBalance } from './services/client.js';
import { startMMDetector, stopMMDetector, checkCurrentMarket } from './services/mmDetector.js';
import { executeMakerRebateStrategy, getActiveMakerPositions, getMarketOdds as getExecutorMarketOdds } from './services/makerRebateExecutor.js';
import { mmFillWatcher } from './services/mmWsFillWatcher.js';

logger.interceptConsole();

// ── Validate config ────────────────────────────────────────────────────────────

try {
    validateMakerMMConfig();
} catch (err) {
    logger.error(`Config error: ${err.message}`);
    process.exit(1);
}

// ── Init CLOB client ──────────────────────────────────────────────────────────

try {
    await initClient();
} catch (err) {
    logger.error(`Client init error: ${err.message}`);
    process.exit(1);
}

// ── Start WebSocket fill watcher ─────────────────────────────────────────────

mmFillWatcher.start();

// ── Override mmDetector config to use maker-mm settings ──────────────────────

config.mmAssets = config.makerMmAssets;
config.mmDuration = config.makerMmDuration;
config.mmPollInterval = config.makerMmPollInterval;
config.mmEntryWindow = config.makerMmEntryWindow;

// ── Periodic status log ──────────────────────────────────────────────────────

async function printStatus() {
    try {
        let balanceStr = 'SIM';
        if (!config.dryRun) {
            try { balanceStr = `$${(await getUsdcBalance()).toFixed(2)} USDC`; } catch { balanceStr = 'N/A'; }
        }

        const positions = getActiveMakerPositions();
        const mode = config.dryRun ? 'SIMULATION' : 'LIVE';

        logger.info(
            `--- MakerMM Status [${mode}] | Balance: ${balanceStr} | Active positions: ${positions.length} ---`,
        );

        for (const pos of positions) {
            const assetTag = pos.asset ? `[${pos.asset.toUpperCase()}] ` : '';
            const label = pos.question.substring(0, 50);
            const msLeft = new Date(pos.endTime).getTime() - Date.now();
            const secsLeft = Math.max(0, Math.round(msLeft / 1000));
            const timeStr = secsLeft > 60
                ? `${Math.floor(secsLeft / 60)}m${secsLeft % 60}s left`
                : `${secsLeft}s left`;

            const yFill = pos.yes.filled ? `FILLED` : `bid $${pos.yes.buyPrice?.toFixed(3)}`;
            const nFill = pos.no.filled ? `FILLED` : `bid $${pos.no.buyPrice?.toFixed(3)}`;
            const combined = (pos.yes.buyPrice + pos.no.buyPrice).toFixed(4);

            logger.info(
                `  ${assetTag}${label} | ${pos.status} | ${timeStr}` +
                ` | combined $${combined}` +
                ` | YES ${pos.targetShares}sh → ${yFill}` +
                ` | NO ${pos.targetShares}sh → ${nFill}`,
            );
        }
    } catch (err) {
        logger.warn(`Status check error: ${err.message}`);
    }
}

// ── Market handler with per-asset queue ──────────────────────────────────────

const pendingByAsset = new Map();
const runningByAsset = new Set(); // tracked from start of runStrategy, not just active positions

/**
 * Check if current market odds allow re-entry
 * For current market: max odds must be <= currentMarketMaxOdds (default 70%)
 */
async function isCurrentMarketOddsValidForReentry(yesTokenId, noTokenId) {
    if (!config.currentMarketEnabled) return false;

    try {
        const odds = await getExecutorMarketOdds(yesTokenId, noTokenId);
        if (!odds) {
            logger.warn(`MakerMM: cannot determine odds — blocking re-entry`);
            return false;
        }

        const threshold = config.currentMarketMaxOdds;
        const valid = odds.max <= threshold;

        if (!valid) {
            logger.warn(
                `MakerMM: current market max odds ${(odds.max * 100).toFixed(1)}% > ${(threshold * 100).toFixed(0)}% ` +
                `— STOPPING re-entry for this market`
            );
        } else {
            logger.info(
                `MakerMM: current market max odds ${(odds.max * 100).toFixed(1)}% <= ${(threshold * 100).toFixed(0)}% ` +
                `— re-entry allowed`
            );
        }

        return valid;
    } catch (err) {
        logger.warn(`MakerMM: odds check error — ${err.message}`);
        return false;
    }
}

async function runStrategy(market) {
    const isCurrentMarket = market.isCurrentMarket ?? false;
    const assetTag = market.asset?.toUpperCase() || '';
    let cycleCount = 0;

    runningByAsset.add(market.asset);

    while (true) {
        cycleCount++;
        if (cycleCount > 1) {
            logger.info(`MakerMM[${assetTag}]: re-entry cycle #${cycleCount}`);
        }

        // ── Check if already have active position for this asset ─────────────
        // Wait for any existing position to complete before starting new one
        const maxWaitMs = 120_000; // Max 2 minutes wait
        const pollIntervalMs = 2_000;
        const waitStart = Date.now();

        while (true) {
            const activePositions = getActiveMakerPositions();
            const hasActivePosition = activePositions.some(p => p.asset === market.asset);

            if (!hasActivePosition) break; // Safe to proceed

            if (Date.now() - waitStart > maxWaitMs) {
                logger.warn(`MakerMM[${assetTag}]: timeout waiting for previous position — skipping cycle`);
                return; // Exit this runStrategy entirely
            }

            logger.info(`MakerMM[${assetTag}]: waiting for previous position to complete...`);
            await new Promise(r => setTimeout(r, pollIntervalMs));
        }

        let cycleResult = { oneSided: false };
        try {
            cycleResult = await executeMakerRebateStrategy(market) ?? { oneSided: false };
        } catch (err) {
            logger.error(`MakerMM strategy error (${assetTag}): ${err.message}`);
        }

        // If cycle ended with one-sided fill (stuck), stop re-entry for this market
        if (cycleResult.oneSided) {
            logger.warn(`MakerMM[${assetTag}]: cycle ended one-sided — stopping re-entry to avoid accumulating exposure`);
            break;
        }

        // Check if we can re-enter (market still active with enough time)
        const msRemaining = new Date(market.endTime).getTime() - Date.now();
        const secsLeft = Math.round(msRemaining / 1000);
        const minTimeForReentry = 180; // 3 minutes minimum

        if (secsLeft > config.makerMmCutLossTime + minTimeForReentry) {
            // ── CURRENT MARKET: Check odds before re-entry ──────────────────────
            if (isCurrentMarket && config.currentMarketEnabled) {
                const oddsValid = await isCurrentMarketOddsValidForReentry(
                    market.yesTokenId,
                    market.noTokenId
                );

                if (!oddsValid) {
                    logger.info(
                        `MakerMM[${assetTag}]: current market odds exceeded threshold — ` +
                        `stopping re-entry, will wait for next market`
                    );
                    break; // Exit to next market instead of re-entering
                }
            }

            const delaySec = config.makerMmReentryDelay / 1000;
            logger.info(`MakerMM[${assetTag}]: waiting ${delaySec}s for re-entry (${secsLeft}s remaining)...`);
            await new Promise(r => setTimeout(r, config.makerMmReentryDelay));
            continue; // Re-enter same market
        }

        // Not enough time for re-entry — check queued market
        break;
    }

    runningByAsset.delete(market.asset);

    const queued = pendingByAsset.get(market.asset);
    if (queued) {
        pendingByAsset.delete(market.asset);

        const endMs = new Date(queued.endTime).getTime();
        const secsLeft = Math.round((endMs - Date.now()) / 1000);

        if (secsLeft > config.makerMmCutLossTime) {
            logger.success(
                `MakerMM[${assetTag}]: position cleared — ` +
                `executing queued "${queued.question.substring(0, 40)}" (${secsLeft}s left)`,
            );
            runStrategy(queued);
        } else {
            logger.warn(
                `MakerMM[${assetTag}]: queued market "${queued.question.substring(0, 40)}" ` +
                `expired (${secsLeft}s left) — discarding`,
            );
        }
    }
}

async function handleNewMarket(market) {
    // Use runningByAsset — tracks from start of runStrategy, not just active positions.
    // This prevents race where next market fires before executeMakerRebateStrategy adds to activePositions.
    const isAssetBusy = runningByAsset.has(market.asset);

    if (isAssetBusy) {
        pendingByAsset.set(market.asset, market);
        logger.warn(
            `MakerMM[${market.asset?.toUpperCase()}]: queued "${market.question.substring(0, 40)}" — ` +
            `will enter after current position clears`,
        );
        return;
    }

    runStrategy(market);
}

// ── Timers ────────────────────────────────────────────────────────────────────

const statusTimer = setInterval(printStatus, 60_000);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown() {
    logger.warn('MakerMM: shutting down...');
    stopMMDetector();
    mmFillWatcher.stop();
    clearInterval(statusTimer);
    setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────

const mode = config.dryRun ? 'SIMULATION' : 'LIVE';
logger.info(`=== Maker Rebate MM [${mode}] ===`);
logger.info(`Assets      : ${config.makerMmAssets.join(', ').toUpperCase()}`);
logger.info(`Duration    : ${config.makerMmDuration}`);
logger.info(`Trade size  : $${config.makerMmTradeSize} per side`);
logger.info(`Max combined: $${config.makerMmMaxCombined}`);
logger.info(`Reprice     : ${config.makerMmRepriceSec}s`);
logger.info(`Fill timeout: ${config.makerMmFillTimeout}s`);
logger.info(`Cut loss    : ${config.makerMmCutLossTime}s before close`);
logger.info(`Entry window: ${config.makerMmEntryWindow}s after open`);
logger.info(`Current MM  : ${config.currentMarketEnabled ? 'ENABLED' : 'disabled'} (max odds: ${(config.currentMarketMaxOdds * 100).toFixed(0)}%)`);
logger.info(`Next MM     : max odds ${(config.nextMarketMaxOdds * 100).toFixed(0)}%`);
logger.info('==========================================');

// Check current active market FIRST so it gets priority and marks asset as running
// before the detector polls for the next market.
await checkCurrentMarket((market) => handleNewMarket({ ...market, isCurrentMarket: true }));
startMMDetector(handleNewMarket);
logger.success(`MakerMM bot started — watching for ${config.makerMmDuration} ${config.makerMmAssets.join('/')} markets...`);
