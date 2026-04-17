import { exec } from 'child_process';
import fs from 'fs';
import { ethers } from 'ethers';
import config from '../config/index.js';
import { getPolygonProvider, getUsdcBalance } from './client.js';
import { execSafeCall, CTF_ADDRESS, USDC_ADDRESS } from './ctf.js';
import { getOpenPositions, removePosition } from './position.js';
import { loadMartingaleState, registerOutcome, printSummary } from './martingale.js';
import { recordSimResult } from '../utils/simStats.js';
import logger from '../utils/logger.js';
import { proxyFetch } from '../utils/proxy.js';
import { sendMessage, notifyWin, notifyLoss } from './telegram.js';

const STOP_LOSS_THRESHOLD   = parseFloat(process.env.STOP_LOSS_THRESHOLD   ?? '5');
const TAKE_PROFIT_THRESHOLD = parseFloat(process.env.TAKE_PROFIT_THRESHOLD ?? '20');

// Track how many times each position has been retried waiting for on-chain payout
const payoutRetryCount = new Map(); // conditionId → retry count

async function checkStopLoss(balance) {
    if (balance !== null && balance < STOP_LOSS_THRESHOLD) {
        logger.warn(`[Redeemer] Low balance warning: $${balance.toFixed(2)} but continuing`);
    }
}

async function checkTakeProfit(balance) {
    if (balance !== null && balance >= TAKE_PROFIT_THRESHOLD) {
        logger.info(`[Redeemer] TAKE PROFIT triggered — balance $${balance.toFixed(2)} >= $${TAKE_PROFIT_THRESHOLD}`);
        await sendMessage(
            `🎯 <b>TAKE PROFIT TRIGGERED</b>\n` +
            `Balance: <b>$${balance.toFixed(2)}</b>\n` +
            `Bot stopped.`,
        );
        exec('pm2 stop martingale-bot');
    }
}

const REDEEM_CFG = {
  baseSize:    parseFloat(process.env.MARTINGALE_BASE_SIZE    ?? '1'),
  multiplier:  parseFloat(process.env.MARTINGALE_MULTIPLIER   ?? '2'),
  maxSteps:    parseInt  (process.env.MARTINGALE_MAX_STEPS    ?? '5', 10),
  resetOnWin:  (process.env.MARTINGALE_RESET_ON_WIN ?? 'true') === 'true',
};

// ── Circuit breaker shared state (FIX 3) ──────────────────────
const CB_FILE = 'data/circuit-breaker.json';

function readCircuitBreakerState() {
    try {
        return JSON.parse(fs.readFileSync(CB_FILE, 'utf8'));
    } catch {
        return { consecutiveLosses: 0, pauseUntil: null };
    }
}

function writeCircuitBreakerState(state) {
    try {
        fs.writeFileSync(CB_FILE, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
    } catch (err) {
        logger.warn(`[Redeemer] Failed to write circuit-breaker.json: ${err.message}`);
    }
}

async function updateCircuitBreakerOnOutcome(isWin, market) {
    const cb = readCircuitBreakerState();
    if (isWin) {
        cb.consecutiveLosses = 0;
        cb.pauseUntil = null;
        writeCircuitBreakerState(cb);
        logger.info(`[Circuit] WIN — reset consecutiveLosses=0 pauseUntil=null`);
    } else {
        cb.consecutiveLosses = (cb.consecutiveLosses ?? 0) + 1;
        let pauseMs = null;
        let pauseLabel = null;
        if (cb.consecutiveLosses === 3)      { pauseMs = 15 * 60 * 1000;       pauseLabel = '15min'; }
        else if (cb.consecutiveLosses === 4) { pauseMs = 60 * 60 * 1000;       pauseLabel = '1hr'; }
        else if (cb.consecutiveLosses >= 5)  { pauseMs = 24 * 60 * 60 * 1000;  pauseLabel = '24hrs'; }
        if (pauseMs !== null) {
            cb.pauseUntil = Date.now() + pauseMs;
            writeCircuitBreakerState(cb);
            logger.warn(`[Circuit] ${cb.consecutiveLosses} consecutive losses → pause ${pauseLabel}`);
            try {
                await sendMessage(
                    `⏸ <b>CIRCUIT BREAKER</b>\n` +
                    `Consecutive losses: ${cb.consecutiveLosses}\n` +
                    `Pausing for: ${pauseLabel}`,
                );
            } catch (err) {
                logger.warn(`[Circuit] Telegram notify failed: ${err.message}`);
            }
        } else {
            writeCircuitBreakerState(cb);
            logger.info(`[Circuit] LOSS — consecutiveLosses=${cb.consecutiveLosses} (no pause yet)`);
        }
    }
}

// CTF ABI (minimal — read-only calls only; writes go through execSafeCall)
const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    'function balanceOf(address owner, uint256 tokenId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
];

/**
 * Check if a market has been resolved via Gamma API.
 * Returns null if the market is not found (e.g. archived old markets).
 */
async function checkMarketResolution(conditionId, tokenId, position) {
    try {
        const url = `${config.gammaHost}/markets?clob_token_ids=${tokenId}`;
        logger.info(`[Redeemer] checkMarketResolution → GET ${url}`);
        const resp = await proxyFetch(url);
        logger.info(`[Redeemer] API status: ${resp.status}`);
        if (!resp.ok) {
            logger.warn(`[Redeemer] API error ${resp.status} for tokenId ${tokenId}`);
            return null;
        }
        const data = await resp.json();
        logger.info(`[Redeemer] API response: ${JSON.stringify(data)}`);
        const markets = Array.isArray(data) ? data : [];

        // Empty → market archived after resolution
        if (markets.length === 0) {
            const ageMin = (Date.now() - new Date(position.createdAt).getTime()) / 60000;
            logger.info(`[Redeemer] API returned empty [] — position age: ${ageMin.toFixed(1)}min`);
            if (ageMin > 6) {
                logger.info('[Redeemer] Market archived (empty response) and position >10min old → treating as resolved');
                return { resolved: true, active: false, question: position.market };
            }
            return null;
        }

        const market = markets[0];
        // Also treat as resolved if the market's end date has passed
        const endDate = new Date(market.endDate ?? market.endTime ?? 0);
        const isPastEnd = endDate.getTime() > 0 && Date.now() > endDate.getTime() + 60_000;
        const result = {
            resolved: market.closed === true || market.resolved === true || isPastEnd,
            active: market.active,
            question: market.question,
        };
        logger.info(`[Redeemer] Resolution result: ${JSON.stringify(result)} | endDate: ${endDate.toISOString()} isPastEnd: ${isPastEnd}`);
        return result;
    } catch (err) {
        logger.warn('[Redeemer] checkMarketResolution error: ' + err.message);
        return null;
    }
}

/**
 * Check on-chain payout fractions for a condition
 * Returns: { resolved: bool, payouts: [yes_fraction, no_fraction] }
 */
async function checkOnChainPayout(conditionId) {
    try {
        logger.info(`[Redeemer] checkOnChainPayout → conditionId: ${conditionId}`);
        const provider = await getPolygonProvider();
        const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

        const denominator = await ctf.payoutDenominator(conditionId);
        logger.info(`[Redeemer] payoutDenominator: ${denominator.toString()}`);
        if (denominator.isZero()) {
            logger.info(`[Redeemer] payoutDenominator is 0 — not yet resolved on-chain`);
            return { resolved: false, payouts: [] };
        }

        const payouts = [];
        for (let i = 0; i < 2; i++) {
            const numerator = await ctf.payoutNumerators(conditionId, i);
            logger.info(`[Redeemer] payoutNumerators[${i}]: ${numerator.toString()}`);
            payouts.push(numerator.toNumber() / denominator.toNumber());
        }

        logger.info(`[Redeemer] On-chain payouts: [YES=${payouts[0]}, NO=${payouts[1]}]`);
        return { resolved: true, payouts };
    } catch (err) {
        logger.warn(`[Redeemer] checkOnChainPayout error: ${err.message}`);
        return { resolved: false, payouts: [] };
    }
}

/**
 * Redeem winning position on-chain via the Gnosis Safe proxy wallet.
 * Uses execSafeCall (same as MM bot) so:
 *   - tx is signed by the EOA but executed FROM the proxy wallet
 *   - Polygon 30 Gwei minimum tip is enforced
 *   - automatic retry on transient errors
 */
async function redeemPosition(conditionId) {
    try {
        const ctfIface = new ethers.utils.Interface(CTF_ABI);
        const data = ctfIface.encodeFunctionData('redeemPositions', [
            USDC_ADDRESS,
            ethers.constants.HashZero,
            conditionId,
            [1, 2],
        ]);

        const label = conditionId.slice(0, 12) + '...';
        logger.info(`[Redeemer] Calling redeemPositions on-chain for ${label}`);
        logger.info(`[Redeemer] CTF_ADDRESS: ${CTF_ADDRESS} | USDC_ADDRESS: ${USDC_ADDRESS}`);
        const receipt = await execSafeCall(CTF_ADDRESS, data, `redeemPositions ${label}`);
        const txHash = receipt.transactionHash;
        logger.success(`[Redeemer] Redeemed in block ${receipt.blockNumber} | tx: ${txHash}`);
        return txHash;
    } catch (err) {
        logger.error(`[Redeemer] redeemPosition FAILED for ${conditionId.slice(0, 12)}...: ${err.message}`);
        logger.error(`[Redeemer] Full error: ${err.stack ?? err.message}`);
        return null;
    }
}

/**
 * Simulate redemption: determine win/loss and record stats
 */
async function simulateRedeem(position) {
    // Need on-chain payout to know who actually won
    const onChain = await checkOnChainPayout(position.conditionId);

    if (!onChain.resolved) {
        logger.info(`[SIM] Market resolved via API but payout not on-chain yet: ${position.market}`);
        return false; // check again next interval
    }

    // outcome index: YES = 0, NO = 1
    const outcomeStr = (position.outcome || 'yes').toLowerCase();
    const outcomeIdx = outcomeStr === 'yes' ? 0 : 1;
    const payoutFraction = onChain.payouts[outcomeIdx] ?? 0;

    // In Polymarket, winning shares redeem at $1 each
    const returned = payoutFraction * position.shares;
    const pnl = returned - position.totalCost;

    if (payoutFraction > 0) {
        logger.money(
            `[SIM] WIN! "${position.market}" | ${position.outcome} won` +
            ` | +$${pnl.toFixed(2)} (+${((pnl / position.totalCost) * 100).toFixed(1)}%)`,
        );
        recordSimResult(position, 'WIN', pnl, returned);
    } else {
        logger.error(
            `[SIM] LOSS: "${position.market}" | ${position.outcome} lost` +
            ` | -$${position.totalCost.toFixed(2)} (-100%)`,
        );
        recordSimResult(position, 'LOSS', pnl, returned);
    }

    removePosition(position.conditionId);
    return { pnl, returned };
}

/**
 * Check all open positions for resolved markets and redeem.
 * WIN/LOSS notifications and step updates are handled by the main bot loop.
 * The redeemer only auto-claims USDC and sends the AUTO CLAIM notification.
 */
export async function checkAndRedeemPositions() {
    const positions = getOpenPositions();
    logger.info('[Redeemer] checking ' + positions.length + ' positions');
    if (positions.length === 0) return;

    logger.info(`[Redeemer] Checking ${positions.length} position(s)...`);

    for (const position of positions) {
        try {
            logger.info(`[Redeemer] Processing: ${position.market.slice(0, 50)} | created: ${position.createdAt}`);

            // Age of position in hours
            const ageHours = (Date.now() - new Date(position.createdAt).getTime()) / 3_600_000;
            logger.info(`[Redeemer] Position age: ${ageHours.toFixed(1)}h`);

            // 1. Quick check via Gamma API
            let resolution = null;
            try {
                resolution = await checkMarketResolution(position.conditionId, position.tokenId, position);
            } catch (resErr) {
                logger.warn(`[Redeemer] Resolution check error for ${position.market.slice(0, 40)}: ${resErr.message}`);
            }
            logger.info(`[Redeemer] API resolution: ${JSON.stringify(resolution)}`);

            if (!resolution?.resolved) {
                logger.info(`[Redeemer] Skipping — not resolved (age=${ageHours.toFixed(1)}h)`);
                continue;
            }

            logger.info(`[Redeemer] Market resolved: ${position.market}`);

            // 2. Verify on-chain payout is set before calling redeemPositions
            const onChain = await checkOnChainPayout(position.conditionId);
            logger.info(`[Redeemer] On-chain result: resolved=${onChain.resolved} payouts=${JSON.stringify(onChain.payouts)}`);
            if (!onChain.resolved) {
                const retries = (payoutRetryCount.get(position.conditionId) ?? 0) + 1;
                payoutRetryCount.set(position.conditionId, retries);
                // For very old positions (>24h) that are unresolvable on-chain, remove them
                const maxRetries = ageHours >= 24 ? 3 : 20;
                if (retries > maxRetries) {
                    logger.warn(`[Redeemer] Position timed out after ${maxRetries} retries (age=${ageHours.toFixed(1)}h) — removing: ${position.market}`);
                    removePosition(position.conditionId);
                    payoutRetryCount.delete(position.conditionId);
                } else {
                    logger.info(`[Redeemer] On-chain payout not set yet — will retry (${retries}/${maxRetries})`);
                }
                continue;
            }
            payoutRetryCount.delete(position.conditionId); // reset on success

            // 3. Simulate (dry-run) or execute real redeem
            if (config.dryRun) {
                const result = await simulateRedeem(position);
                if (result) {
                    const { pnl, returned } = result;
                    logger.money(`[Redeemer][SIM] Auto-claim: ${position.market} → $${returned.toFixed(4)} USDC`);

                    const state    = loadMartingaleState();
                    const outcome  = pnl > 0 ? 'win' : 'loss';
                    const newState = registerOutcome(REDEEM_CFG, state, outcome, pnl, position.conditionId);
                    printSummary(newState, REDEEM_CFG);

                    const totalPnl = (newState.history ?? []).reduce((acc, h) => acc + (h.pnl ?? 0), 0);
                    const nextBet  = REDEEM_CFG.baseSize * Math.pow(REDEEM_CFG.multiplier, newState.step);
                    let balance = null;
                    try { balance = await getUsdcBalance(); } catch { /* non-fatal */ }
                    if (pnl > 0) {
                        notifyWin({ market: position.market, pnl, step: newState.step, totalPnl, balance, txHash: null });
                        await checkTakeProfit(balance);
                    } else {
                        notifyLoss({ market: position.market, pnl, newStep: newState.step, nextBet, balance, totalPnl, txHash: null });
                        await checkStopLoss(balance);
                    }
                    await updateCircuitBreakerOnOutcome(pnl > 0, position.market);
                }
            } else {
                const txHash = await redeemPosition(position.conditionId);
                if (txHash) {
                    const outcomeIdx     = (position.outcome || 'yes').toLowerCase() === 'yes' ? 0 : 1;
                    const payoutFraction = onChain.payouts[outcomeIdx] ?? 0;
                    const returned       = payoutFraction * position.shares;
                    const pnl            = returned - position.totalCost;

                    removePosition(position.conditionId);
                    logger.money(`[Redeemer] Claimed: ${position.market} → ${returned.toFixed(4)} USDC`);

                    // Store claim info for martingale-bot to merge into win/loss message
                    try {
                        fs.writeFileSync('data/last-claim.json', JSON.stringify({
                            conditionId: position.conditionId,
                            txHash,
                            amount: returned,
                            outcome: position.outcome,
                            ts: new Date().toISOString(),
                        }, null, 2));
                    } catch (err) {
                        logger.warn(`[Redeemer] Failed to write last-claim.json: ${err.message}`);
                    }

                    const state    = loadMartingaleState();
                    const outcome  = pnl > 0 ? 'win' : 'loss';
                    const newState = registerOutcome(REDEEM_CFG, state, outcome, pnl, position.conditionId);
                    printSummary(newState, REDEEM_CFG);

                    const totalPnl = (newState.history ?? []).reduce((acc, h) => acc + (h.pnl ?? 0), 0);
                    const nextBet  = REDEEM_CFG.baseSize * Math.pow(REDEEM_CFG.multiplier, newState.step);
                    let balance = null;
                    try { balance = await getUsdcBalance(); } catch { /* non-fatal */ }
                    if (pnl > 0) {
                        notifyWin({ market: position.market, pnl, step: newState.step, totalPnl, balance, txHash });
                        await checkTakeProfit(balance);
                    } else {
                        notifyLoss({ market: position.market, pnl, newStep: newState.step, nextBet, balance, totalPnl, txHash });
                        await checkStopLoss(balance);
                    }
                    await updateCircuitBreakerOnOutcome(pnl > 0, position.market);
                } else {
                    logger.warn(`[Redeemer] Redeem failed for ${position.market} — will retry`);
                }
            }
        } catch (err) {
            logger.error(`[Redeemer] Error on ${position.market}: ${err.message}`);
        }
    }
}
