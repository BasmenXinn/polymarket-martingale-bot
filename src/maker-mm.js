/**
 * maker-mm.js
 * Entry point for the Maker Rebate MM bot (TUI).
 * Buys YES+NO at top bid (maker) → merges → profit from spread + rebates.
 * Run with: npm run maker-mm       (live)
 *           npm run maker-mm-sim   (simulation / dry-run)
 */

// Set proxy before any network calls
import './utils/proxy-patch.cjs';

import { validateMakerMMConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient, getClient } from './services/client.js';
import { initDashboard, appendLog, updateStatus, isDashboardActive } from './ui/dashboard.js';
import { startMMDetector, stopMMDetector, checkCurrentMarket } from './services/mmDetector.js';
import { executeMakerRebateStrategy, getActiveMakerPositions } from './services/makerRebateExecutor.js';
import { mmFillWatcher } from './services/mmWsFillWatcher.js';
import { getUsdcBalance } from './services/client.js';

// ── Validate config ────────────────────────────────────────────────────────────

try {
    validateMakerMMConfig();
} catch (err) {
    console.error(`Config error: ${err.message}`);
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

// ── Start WebSocket fill watcher for real-time order detection ────────────────

mmFillWatcher.start();

// ── Override mmDetector config to use maker-mm settings ──────────────────────

config.mmAssets = config.makerMmAssets;
config.mmDuration = config.makerMmDuration;
config.mmPollInterval = config.makerMmPollInterval;
config.mmEntryWindow = config.makerMmEntryWindow;

// ── Status panel refresh ──────────────────────────────────────────────────────

async function buildStatusContent() {
    let lines = [];

    // Balance
    let balance = '?';
    if (!config.dryRun) {
        try { balance = (await getUsdcBalance()).toFixed(2); } catch { /* ignore */ }
    } else {
        balance = '{yellow-fg}SIM{/yellow-fg}';
    }
    lines.push(`{bold}BALANCE{/bold}`);
    lines.push(`  USDC.e: {green-fg}$${balance}{/green-fg}`);
    lines.push('');

    // Mode
    lines.push(`{bold}MODE{/bold}`);
    lines.push(`  ${config.dryRun ? '{yellow-fg}SIMULATION{/yellow-fg}' : '{green-fg}LIVE{/green-fg}'}`);
    lines.push(`  Strategy: {cyan-fg}MAKER REBATE{/cyan-fg}`);
    lines.push('');

    // Config
    lines.push(`{bold}MAKER MM CONFIG{/bold}`);
    lines.push(`  Assets      : ${config.makerMmAssets.join(', ').toUpperCase()}`);
    lines.push(`  Duration    : ${config.makerMmDuration}`);
    lines.push(`  Trade sz    : $${config.makerMmTradeSize} per side`);
    lines.push(`  Max combined: $${config.makerMmMaxCombined}`);
    lines.push(`  Reprice     : ${config.makerMmRepriceSec}s`);
    lines.push(`  Fill timeout: ${config.makerMmFillTimeout}s`);
    lines.push(`  Cut loss    : ${config.makerMmCutLossTime}s before close`);
    lines.push('');

    // Active positions
    const positions = getActiveMakerPositions();
    lines.push(`{bold}ACTIVE POSITIONS (${positions.length}){/bold}`);

    if (positions.length === 0) {
        lines.push('  {gray-fg}Waiting for market...{/gray-fg}');
    } else {
        for (const pos of positions) {
            const assetTag = pos.asset ? `[${pos.asset.toUpperCase()}] ` : '';
            const label = pos.question.substring(0, 32);
            const msLeft = new Date(pos.endTime).getTime() - Date.now();
            const secsLeft = Math.max(0, Math.round(msLeft / 1000));
            const timeStr = secsLeft > 60
                ? `${Math.floor(secsLeft / 60)}m${secsLeft % 60}s`
                : `{red-fg}${secsLeft}s{/red-fg}`;

            const combined = (pos.yes.buyPrice + pos.no.buyPrice).toFixed(4);
            const spread = (1 - pos.yes.buyPrice - pos.no.buyPrice).toFixed(4);

            lines.push(`  {cyan-fg}${assetTag}${label}{/cyan-fg}`);
            lines.push(`  Status : ${pos.status} | Time left: ${timeStr}`);
            lines.push(`  Combined: $${combined} | Spread: $${spread}`);

            // YES side
            const yFill = pos.yes.filled
                ? `{green-fg}FILLED{/green-fg}`
                : `{yellow-fg}bid $${pos.yes.buyPrice?.toFixed(3)}{/yellow-fg}`;
            lines.push(`  YES  ${pos.targetShares?.toFixed(1)} sh @ $${pos.yes.buyPrice?.toFixed(3)} → ${yFill}`);

            // NO side
            const nFill = pos.no.filled
                ? `{green-fg}FILLED{/green-fg}`
                : `{yellow-fg}bid $${pos.no.buyPrice?.toFixed(3)}{/yellow-fg}`;
            lines.push(`  NO   ${pos.targetShares?.toFixed(1)} sh @ $${pos.no.buyPrice?.toFixed(3)} → ${nFill}`);

            if (pos.totalProfit !== 0) {
                const sign = pos.totalProfit >= 0 ? '+' : '';
                const color = pos.totalProfit >= 0 ? 'green' : 'red';
                lines.push(`  P&L: {${color}-fg}${sign}$${pos.totalProfit.toFixed(2)}{/${color}-fg}`);
            }

            lines.push('');
        }
    }

    return '\n' + lines.join('\n');
}

let refreshTimer = null;

function startRefresh() {
    refreshTimer = setInterval(async () => {
        if (!isDashboardActive()) return;
        const content = await buildStatusContent();
        updateStatus(content);
    }, 3000);

    // Immediate refresh
    buildStatusContent().then(updateStatus);
}

// ── Market handler with per-asset queue ──────────────────────────────────────

const pendingByAsset = new Map();

async function runStrategy(market) {
    try {
        await executeMakerRebateStrategy(market);
    } catch (err) {
        logger.error(`MakerMM strategy error (${market.asset?.toUpperCase()}): ${err.message}`);
    }

    // After position clears, execute queued market for this asset
    const queued = pendingByAsset.get(market.asset);
    if (queued) {
        pendingByAsset.delete(market.asset);

        const endMs = new Date(queued.endTime).getTime();
        const secsLeft = Math.round((endMs - Date.now()) / 1000);

        if (secsLeft > config.makerMmCutLossTime) {
            logger.success(
                `MakerMM[${market.asset?.toUpperCase()}]: position cleared — ` +
                `executing queued "${queued.question.substring(0, 40)}" (${secsLeft}s left)`,
            );
            runStrategy(queued);
        } else {
            logger.warn(
                `MakerMM[${market.asset?.toUpperCase()}]: queued market "${queued.question.substring(0, 40)}" ` +
                `expired (${secsLeft}s left) — discarding`,
            );
        }
    }
}

async function handleNewMarket(market) {
    const active = getActiveMakerPositions();
    const isAssetBusy = active.some((p) => p.asset === market.asset);

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

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown() {
    logger.warn('MakerMM: shutting down...');
    stopMMDetector();
    mmFillWatcher.stop();
    if (refreshTimer) clearInterval(refreshTimer);
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────

logger.info(`MakerMM bot starting — ${config.dryRun ? 'SIMULATION MODE' : 'LIVE MODE'} | assets: ${config.makerMmAssets.join(', ').toUpperCase()} | ${config.makerMmDuration}`);
startRefresh();
startMMDetector(handleNewMarket);
// Immediately check if there's a current active market to enter
checkCurrentMarket(handleNewMarket);
