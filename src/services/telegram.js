/**
 * Telegram Bot service for Martingale Bot monitoring
 * Uses Bot API directly (no library needed) with long-polling for commands
 */
import logger from '../utils/logger.js';

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE    = `https://api.telegram.org/bot${TOKEN}`;

let lastUpdateId  = 0;
let pollingTimer  = null;
let startedAt     = 0;

// ── Send a message ────────────────────────────────────────────
export function sendMessage(text) {
  if (!TOKEN || !CHAT_ID) return;
  fetch(`${BASE}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
  }).catch(e => logger.warn('[Telegram] send error: ' + e.message));
}

// ── Convenience wrappers ──────────────────────────────────────
export function notifyBuy({ market, betSize, price, side }) {
  return sendMessage(
    `📥 <b>BUY ORDER PLACED</b>\n` +
    `Market : ${escHtml(market.slice(0, 60))}\n` +
    `Side   : ${side}\n` +
    `Size   : $${betSize.toFixed(2)}\n` +
    `Price  : $${price.toFixed(3)}`,
  );
}

export function notifyWin({ market, pnl, step, totalPnl, balance }) {
  const balanceLine = balance != null ? `\n💰 Balance: $${balance.toFixed(2)}` : '';
  return sendMessage(
    `✅ <b>WIN</b>\n` +
    `Market   : ${escHtml(market.slice(0, 60))}\n` +
    `PnL      : +$${pnl.toFixed(2)}\n` +
    `Step     : reset → 0\n` +
    `Total PnL: $${totalPnl.toFixed(2)}` +
    balanceLine,
  );
}

export function notifyLoss({ market, pnl, newStep, nextBet, balance }) {
  const balanceLine = balance != null ? `\n💰 Balance: $${balance.toFixed(2)}` : '';
  return sendMessage(
    `❌ <b>LOSS</b>\n` +
    `Market  : ${escHtml(market.slice(0, 60))}\n` +
    `PnL     : -$${Math.abs(pnl).toFixed(2)}\n` +
    `New Step: ${newStep}\n` +
    `Next Bet: $${nextBet.toFixed(2)}` +
    balanceLine,
  );
}

export function notifyError(message) {
  return sendMessage(`🚨 <b>BOT ERROR</b>\n${escHtml(message)}`);
}

export function notifyRedeem({ market, amount, pnl, txHash }) {
  const sign   = pnl >= 0 ? '+' : '';
  const shortTx = txHash ? txHash.slice(0, 10) + '...' : 'n/a';
  return sendMessage(
    `💰 <b>AUTO CLAIM SUCCESS</b>\n` +
    `Market: ${escHtml(market.slice(0, 60))}\n` +
    `Amount: ${amount.toFixed(4)} USDC (${sign}$${pnl.toFixed(4)})\n` +
    `TX: ${shortTx}`,
  );
}

export function notifyAutoSell({ market, sellPrice, estimatedPnl }) {
  return sendMessage(
    `🎯 <b>AUTO-SELL TRIGGERED</b>\n` +
    `Market: ${escHtml(market.slice(0, 60))}\n` +
    `Sell @ : $${sellPrice.toFixed(3)}\n` +
    `Est PnL: +$${estimatedPnl.toFixed(2)}`,
  );
}

// ── Command polling ───────────────────────────────────────────
export async function startPolling(commandHandler) {
  if (!TOKEN || !CHAT_ID) {
    logger.warn('[Telegram] TOKEN or CHAT_ID not set — Telegram disabled');
    return;
  }

  startedAt = Math.floor(Date.now() / 1000);

  // Drain the pending queue so old /stop commands are never processed
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${BASE}/getUpdates?limit=1&allowed_updates=["message"]`, { signal: controller.signal });
    clearTimeout(t);
    if (res.ok) {
      const data = await res.json();
      const updates = data.result ?? [];
      if (updates.length > 0) {
        lastUpdateId = updates[updates.length - 1].update_id;
        logger.info(`[Telegram] Skipping old messages up to update_id=${lastUpdateId}`);
      }
    }
  } catch (e) {
    logger.warn('[Telegram] Could not fetch initial offset: ' + e.message);
  }

  logger.info('[Telegram] Command polling started');
  sendMessage('🤖 <b>Martingale Bot started</b>\nCommands: /status /pnl /stop /btc /sol /eth /asset');

  async function poll() {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      const url = `${BASE}/getUpdates?offset=${lastUpdateId + 1}&timeout=3&allowed_updates=["message"]`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(t);
      if (res.ok) {
        const data = await res.json();
        for (const update of data.result ?? []) {
          lastUpdateId = update.update_id;
          const msgDate   = update.message?.date ?? 0;
          const msgChatId = String(update.message?.chat?.id ?? '');
          const text      = (update.message?.text ?? '').trim();
          if (msgChatId !== String(CHAT_ID)) continue;
          if (msgDate < startedAt) {
            logger.info(`[Telegram] Skipping old command: ${text}`);
            continue;
          }
          await commandHandler(text);
        }
      }
    } catch (err) {
      logger.warn(`[Telegram] Poll error: ${err.message}`);
    }
    pollingTimer = setTimeout(poll, 1000);
  }

  poll();
}

export function stopPolling() {
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }
}

// ── Helpers ───────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
