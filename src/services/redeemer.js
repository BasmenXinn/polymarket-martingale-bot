import { exec } from 'child_process';
import { ethers } from 'ethers';
import config from '../config/index.js';
import { getPolygonProvider, getUsdcBalance } from './client.js';
import { execSafeCall, CTF_ADDRESS, USDC_ADDRESS } from './ctf.js';
import { getOpenPositions, removePosition } from './position.js';
import { loadMartingaleState, registerOutcome, printSummary } from './martingale.js';
import { recordSimResult } from '../utils/simStats.js';
import logger from '../utils/logger.js';
import { proxyFetch } from '../utils/proxy.js';
import { sendMessage, notifyRedeem, notifyWin, notifyLoss } from './telegram.js';

const STOP_LOSS_THRESHOLD   = parseFloat(process.env.STOP_LOSS_THRESHOLD   ?? '5');
const TAKE_PROFIT_THRESHOLD = parseFloat(process.env.TAKE_PROFIT_THRESHOLD ?? '20');

async function checkStopLoss(balance) {
    if (balance !== null && balance < STOP_LOSS_THRESHOLD) {
        logger.warn(`[Redeemer] STOP LOSS triggered — balance $${balance.toFixed(2)} < $${STOP_LOSS_THRESHOLD}`);
        await sendMessage(
            `🛑 <b>STOP LOSS TRIGGERED</b>\n` +
            `Balance: <b>$${balance.toFixed(2)}</b>\n` +
            `Bot stopped.`,
        );
        exec('pm2 stop martingale-bot');
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

// CTF ABI (minimal — read-only calls only; writes go through execSafeCall)
const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    'function balanceOf(address owner, uint256 tokenId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
];

/**
 * Check if a market has been resolved via Gamma API
 */
async function checkMarketResolution(conditionId) {
    try {
        const url = `${config.gammaHost}/markets?condition_id=${conditionId}`;
        const response = await proxyFetch(url);
        if (!response.ok) return null;

        const markets = await response.json();
        if (!markets || markets.length === 0) return null;

        const market = markets[0];
        return {
            resolved: market.closed || market.resolved || false,
            active: market.active,
            question: market.question,
        };
    } catch (err) {
        logger.error('Failed to check market resolution:', err.message);
        return null;
    }
}

/**
 * Check on-chain payout fractions for a condition
 * Returns: { resolved: bool, payouts: [yes_fraction, no_fraction] }
 */
async function checkOnChainPayout(conditionId) {
    try {
        const provider = await getPolygonProvider();
        const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

        const denominator = await ctf.payoutDenominator(conditionId);
        if (denominator.isZero()) return { resolved: false, payouts: [] };

        const payouts = [];
        for (let i = 0; i < 2; i++) {
            const numerator = await ctf.payoutNumerators(conditionId, i);
            payouts.push(numerator.toNumber() / denominator.toNumber());
        }

        return { resolved: true, payouts };
    } catch {
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
        logger.info(`Redeeming position: ${label}`);
        const receipt = await execSafeCall(CTF_ADDRESS, data, `redeemPositions ${label}`);
        const txHash = receipt.transactionHash;
        logger.success(`Redeemed in block ${receipt.blockNumber} | tx: ${txHash}`);
        return txHash;
    } catch (err) {
        logger.error(`Failed to redeem: ${err.message}`);
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
            // 1. Quick check via Gamma API
            const resolution = await checkMarketResolution(position.conditionId);
            if (!resolution?.resolved) continue;

            logger.info(`[Redeemer] Market resolved: ${position.market}`);

            // 2. Verify on-chain payout is set before calling redeemPositions
            const onChain = await checkOnChainPayout(position.conditionId);
            if (!onChain.resolved) {
                logger.info(`[Redeemer] On-chain payout not set yet — will retry`);
                continue;
            }

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
                        notifyWin({ market: position.market, pnl, step: newState.step, totalPnl, balance });
                        await checkTakeProfit(balance);
                    } else {
                        notifyLoss({ market: position.market, pnl, newStep: newState.step, nextBet, balance });
                        await checkStopLoss(balance);
                    }
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

                    const state    = loadMartingaleState();
                    const outcome  = pnl > 0 ? 'win' : 'loss';
                    const newState = registerOutcome(REDEEM_CFG, state, outcome, pnl, position.conditionId);
                    printSummary(newState, REDEEM_CFG);

                    const totalPnl = (newState.history ?? []).reduce((acc, h) => acc + (h.pnl ?? 0), 0);
                    const nextBet  = REDEEM_CFG.baseSize * Math.pow(REDEEM_CFG.multiplier, newState.step);
                    let balance = null;
                    try { balance = await getUsdcBalance(); } catch { /* non-fatal */ }
                    if (pnl > 0) {
                        notifyWin({ market: position.market, pnl, step: newState.step, totalPnl, balance });
                        await checkTakeProfit(balance);
                    } else {
                        notifyLoss({ market: position.market, pnl, newStep: newState.step, nextBet, balance });
                        await checkStopLoss(balance);
                    }
                    notifyRedeem({ market: position.market, amount: returned, pnl, txHash });
                } else {
                    logger.warn(`[Redeemer] Redeem failed for ${position.market} — will retry`);
                }
            }
        } catch (err) {
            logger.error(`[Redeemer] Error on ${position.market}: ${err.message}`);
        }
    }
}
