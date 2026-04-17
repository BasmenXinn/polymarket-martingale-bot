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
export function notifyBuy({ market, betSize, price, side, mode, timeWIB, reason }) {
  return sendMessage(
    '📥 <b>BET PLACED</b>\n' +
    '━━━━━━━━━━━━━━━━━\n' +
    '📋 ' + escHtml(market.slice(0, 50)) + '\n\n' +
    '🎯 Side    : <b>' + side + '</b>\n' +
    '💰 Size    : $' + betSize.toFixed(2) + '\n' +
    '📈 Price   : $' + price.toFixed(3) + '\n' +
    (mode    ? '🤖 Mode    : ' + mode + '\n' : '') +
    (timeWIB ? '🕐 Time    : ' + timeWIB + ' WIB\n' : '') +
    (reason  ? '💡 Signal  : ' + escHtml(reason) + '\n' : '') +
    '━━━━━━━━━━━━━━━━━',
  );
}

export function notifyWin({ market, pnl, step, totalPnl, balance, txHash }) {
  return sendMessage(
    '🏆 <b>WIN!</b>\n' +
    '━━━━━━━━━━━━━━━━━\n' +
    '📋 ' + escHtml(market.slice(0, 50)) + '\n\n' +
    '💰 Profit    : <b>+$' + pnl.toFixed(2) + '</b>\n' +
    '📊 Total PnL : $' + (totalPnl != null ? totalPnl.toFixed(2) : '—') + (totalPnl != null ? (totalPnl >= 0 ? ' 📈' : ' 📉') : '') + '\n' +
    '🏦 Balance   : $' + (balance != null ? balance.toFixed(2) : '—') + '\n' +
    '🎯 Next Step : 0 (reset)\n' +
    (txHash ? '🔗 TX: ' + txHash.slice(0, 10) + '...\n' : '') +
    '━━━━━━━━━━━━━━━━━',
  );
}

export function notifyLoss({ market, pnl, newStep, nextBet, balance, totalPnl, txHash }) {
  return sendMessage(
    '❌ <b>LOSS</b>\n' +
    '━━━━━━━━━━━━━━━━━\n' +
    '📋 ' + escHtml(market.slice(0, 50)) + '\n\n' +
    '💸 Loss      : <b>-$' + Math.abs(pnl).toFixed(2) + '</b>\n' +
    '📊 Total PnL : $' + (totalPnl != null ? totalPnl.toFixed(2) : '—') + (totalPnl != null ? (totalPnl >= 0 ? ' 📈' : ' 📉') : '') + '\n' +
    '🏦 Balance   : $' + (balance != null ? balance.toFixed(2) : '—') + '\n' +
    '⚡ Next Step : ' + newStep + ' → Bet $' + nextBet.toFixed(2) + '\n' +
    (txHash ? '🔗 TX: ' + txHash.slice(0, 10) + '...\n' : '') +
    '━━━━━━━━━━━━━━━━━',
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
  sendMessage(
    `🤖 <b>Martingale Bot V2 — Online!</b>\n\n` +
    `<b>📊 Status &amp; Info</b>\n` +
    `├ /status — Cek status bot lengkap\n` +
    `├ /pnl — Cek profit/loss\n` +
    `└ /asset — Cek asset aktif saat ini\n\n` +
    `<b>🎮 Kontrol Bot</b>\n` +
    `├ /start — Mulai bot (resume setelah /stop)\n` +
    `├ /stop — Hentikan bot sementara\n` +
    `└ /reset — Reset semua state &amp; PnL\n\n` +
    `<b>🎯 Pilih Arah Bet</b>\n` +
    `├ /yes — Paksa bet YES terus\n` +
    `├ /no — Paksa bet NO terus\n` +
    `└ /auto — Analisa otomatis (default)\n\n` +
    `<b>💰 Mode Bet</b>\n` +
    `├ /martingale — Martingale (double on loss)\n` +
    `├ /flat — Flat $1 tanpa double\n` +
    `└ /kelly — Kelly Criterion (dynamic sizing)\n\n` +
    `<b>📈 Pilih Market</b>\n` +
    `├ /btc — Bitcoin 5m\n` +
    `├ /btc15 — Bitcoin 15m\n` +
    `├ /sol — Solana 5m\n` +
    `├ /eth — Ethereum 5m\n` +
    `├ /xrp — XRP 5m\n` +
    `└ /doge — Dogecoin 5m\n\n` +
    `<b>🌍 Multi-Market Manual</b>\n` +
    `├ /mode btc/sports/politics — switch trading mode\n` +
    `├ /search <keyword> — cari market manual\n` +
    `├ /pick <nomor> — pilih market\n` +
    `├ /analyze — analisa LLM\n` +
    `└ /bet yes/no — eksekusi bet manual\n\n` +
    `<b>🔧 Manual Tools</b>\n` +
    `├ /redeem — Trigger claim manual\n` +
    `└ /help — Lihat semua command\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚡ Bot siap trading! Semoga profit! 🚀`
  );

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
