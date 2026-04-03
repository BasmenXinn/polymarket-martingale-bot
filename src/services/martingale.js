import logger from '../utils/logger.js';
import fs from 'fs';

const STATE_FILE = 'data/martingale-state.json';

export function loadMartingaleState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { step: 0, currentSize: null, history: [] };
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { step: 0, currentSize: null, history: [] };
  }
}

export function saveMartingaleState(state) {
  if (!fs.existsSync('data')) fs.mkdirSync('data');
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function calcNextBetSize(cfg, state) {
  const base     = cfg.baseSize  ?? 1;
  const mult     = cfg.multiplier ?? 2;
  const maxSteps = cfg.maxSteps  ?? 5;
  const step     = Math.min(state.step ?? 0, maxSteps);
  const size     = base * Math.pow(mult, step);
  logger.info(`[Martingale] Step ${step}/${maxSteps} -> Bet size: $${size.toFixed(2)} USDC`);
  return size;
}

export function registerOutcome(cfg, state, outcome, pnl, marketId) {
  const maxSteps  = cfg.maxSteps  ?? 5;
  const resetOnWin = cfg.resetOnWin ?? true;
  const entry = {
    ts: new Date().toISOString(),
    marketId,
    outcome,
    pnl,
    stepBefore: state.step,
  };
  let newStep;
  if (outcome === 'win') {
    newStep = resetOnWin ? 0 : Math.max(0, state.step - 1);
    logger.info(`[Martingale] WIN  PnL: $${pnl.toFixed(2)} -> reset ke step ${newStep}`);
  } else {
    newStep = Math.min(state.step + 1, maxSteps);
    logger.warn(`[Martingale] LOSS  PnL: $${pnl.toFixed(2)} -> naik ke step ${newStep}`);
  }
  const newState = {
    step: newStep,
    currentSize: null,
    history: [...(state.history ?? []).slice(-99), entry],
  };
  saveMartingaleState(newState);
  return newState;
}

export function shouldPause(balance, nextBetSize) {
  if (balance < nextBetSize) {
    logger.error(`[Martingale] Balance $${balance.toFixed(2)} tidak cukup untuk bet $${nextBetSize.toFixed(2)}. Pausing.`);
    return true;
  }
  return false;
}

export function printSummary(state, cfg) {
  const history  = state.history ?? [];
  const wins     = history.filter(h => h.outcome === 'win').length;
  const losses   = history.filter(h => h.outcome === 'loss').length;
  const totalPnl = history.reduce((acc, h) => acc + (h.pnl ?? 0), 0);
  logger.info('--------------------------------------------------');
  logger.info('[Martingale] SESSION SUMMARY');
  logger.info(`  Step saat ini : ${state.step} / ${cfg.maxSteps ?? 5}`);
  logger.info(`[Martingale] Step ${state.step}/${cfg.maxSteps ?? 5} -> Bet size: $${calcNextBetSize(cfg, state).toFixed(2)} USDC`);
  logger.info(`  Bet berikutnya: $${calcNextBetSize(cfg, state).toFixed(2)} USDC`);
  logger.info(`  Total trade   : ${history.length}  (W: ${wins}  L: ${losses})`);
  logger.info(`  Total PnL     : $${totalPnl.toFixed(2)} USDC`);
  logger.info('--------------------------------------------------');
}
