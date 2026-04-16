import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');
const DATA      = path.join(ROOT, 'data');

const PORT          = parseInt(process.env.PORT ?? '3000', 10);
const DASHBOARD_KEY = process.env.DASHBOARD_KEY ?? 'polymarket';

const app = express();

// ── Auth middleware ───────────────────────────────────────────
function auth(req, res, next) {
  if (req.query.key !== DASHBOARD_KEY) {
    return res.status(401).json({ error: 'Unauthorized. Add ?key=polymarket to the URL.' });
  }
  next();
}

// ── Helpers ───────────────────────────────────────────────────
function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, filename), 'utf8'));
  } catch {
    return null;
  }
}

function parseEnv() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const result = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) result[m[1]] = m[2].trim();
    }
    return result;
  } catch {
    return {};
  }
}

// ── Binance data with 2-second cache ─────────────────────────
let binanceCache = null;
let binanceCacheAt = 0;

async function getBinanceData() {
  const now = Date.now();
  if (binanceCache && now - binanceCacheAt < 2000) return binanceCache;

  try {
    const t0 = Date.now();
    const [priceRes, depthRes, statsRes, candlesRes] = await Promise.all([
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'),
      fetch('https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=8'),
      fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT'),
      fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=6'),
    ]);
    const binanceLatency = Date.now() - t0;

    const price   = await priceRes.json();
    const depth   = await depthRes.json();
    const stats   = await statsRes.json();
    const candles = await candlesRes.json();

    const bids = depth.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
    const asks = depth.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
    const totalBid = bids.reduce((a, b) => a + b[1], 0);
    const totalAsk = asks.reduce((a, b) => a + b[1], 0);
    const obi20  = (totalBid - totalAsk) / (totalBid + totalAsk);
    const depthR = totalBid / totalAsk;

    const closes  = candles.map(k => parseFloat(k[4]));
    const current = closes[closes.length - 1];
    const prev5   = closes[0];
    const mom30s  = (current - prev5) / prev5;
    const volumes = candles.map(k => parseFloat(k[5]));
    const avgVol  = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
    const vol     = volumes[volumes.length - 1] / avgVol;

    binanceCache = {
      price:     parseFloat(price.price),
      change24h: parseFloat(stats.priceChangePercent),
      bids:      bids.slice(0, 8),
      asks:      asks.slice(0, 8),
      obi20, depthR, mom30s, vol,
      totalBid, totalAsk,
      binanceLatency,
    };
    binanceCacheAt = now;
    return binanceCache;
  } catch (err) {
    console.error('[Binance] fetch error:', err.message);
    return binanceCache ?? {
      price: null, change24h: 0,
      bids: [], asks: [],
      obi20: 0, depthR: 1, mom30s: 0, vol: 1,
      totalBid: 0, totalAsk: 0, binanceLatency: null,
    };
  }
}

// ── Routes ────────────────────────────────────────────────────

// Serve dashboard HTML (no auth — key is handled in JS)
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Binance market data endpoint
app.get('/api/binance', auth, async (_req, res) => {
  const data = await getBinanceData();
  res.json(data);
});

// Main stats endpoint
app.get('/api/stats', auth, (_req, res) => {
  const state     = readJson('martingale-state.json') ?? { step: 0, history: [] };
  const positions = readJson('positions.json')        ?? {};
  const cb        = readJson('circuit-breaker.json')  ?? { consecutiveLosses: 0, pauseUntil: null };
  const dash      = readJson('dashboard.json')        ?? {};
  const env       = parseEnv();

  const history  = state.history ?? [];
  const wins     = history.filter(h => h.outcome === 'win').length;
  const losses   = history.filter(h => h.outcome === 'loss').length;
  const totalPnl = history.reduce((acc, h) => acc + (h.pnl ?? 0), 0);
  const winRate  = history.length > 0
    ? ((wins / history.length) * 100).toFixed(1)
    : '0.0';

  // Current streak (consecutive same outcome from end)
  let streak = 0;
  let streakOutcome = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const o = history[i].outcome;
    if (streakOutcome === null) { streakOutcome = o; streak = 1; }
    else if (o === streakOutcome) streak++;
    else break;
  }

  // Daily stats fallback
  const today            = new Date().toISOString().slice(0, 10);
  const todayTrades      = history.filter(h => h.ts?.slice(0, 10) === today);
  const dailyPnlFallback = todayTrades.reduce((acc, h) => acc + (h.pnl ?? 0), 0);

  const baseSize = parseFloat(env.MARTINGALE_BASE_SIZE  ?? '1');
  const mult     = parseFloat(env.MARTINGALE_MULTIPLIER ?? '2');
  const maxSteps = parseInt(env.MARTINGALE_MAX_STEPS    ?? '1', 10);

  // Enrich recent trades with size/price/confidence/ttx
  const recentTrades = history.slice(-20).reverse().map(h => ({
    ts:          h.ts,
    outcome:     h.outcome,
    pnl:         h.pnl,
    side:        h.side        ?? 'YES',
    size:        h.size        ?? (baseSize * Math.pow(mult, h.stepBefore ?? 0)),
    price:       h.price       ?? 0.97,
    confidence:  h.confidence  ?? 0.33,
    ttx:         h.ttx         ?? '--',
    stepBefore:  h.stepBefore  ?? 0,
  }));

  // Current market info from last bet
  const lastBet = dash.lastBet ?? null;
  const currentMarket = lastBet ? {
    slug:    lastBet.market ?? null,
    endTime: lastBet.endTime ?? null,
  } : null;

  // CLOB latency estimate (ms since last dashboard.json write)
  const clobLatency = dash.updatedAt
    ? Math.min(9999, Date.now() - new Date(dash.updatedAt).getTime())
    : null;

  res.json({
    // Bot state
    step:            state.step,
    maxSteps,
    baseSize,
    multiplier:      mult,
    // Trade stats
    totalTrades:     history.length,
    wins,
    losses,
    winRate,
    totalPnl,
    dailyPnl:        dash.dailyPnl        ?? dailyPnlFallback,
    dailyTradeCount: dash.dailyTradeCount ?? todayTrades.length,
    dailyTradesLeft: 80 - (dash.dailyTradeCount ?? todayTrades.length),
    currentStreak:   streak,
    streakOutcome:   streakOutcome ?? 'none',
    // Circuit breaker (as sub-object + flat fields for compat)
    circuitBreaker: {
      consecutiveLosses: cb.consecutiveLosses ?? 0,
      pauseUntil:        cb.pauseUntil        ?? null,
    },
    consecutiveLosses: cb.consecutiveLosses,
    pauseUntil:        cb.pauseUntil,
    pauseActive:       !!(cb.pauseUntil && Date.now() < cb.pauseUntil),
    pauseRemainingMin: cb.pauseUntil && Date.now() < cb.pauseUntil
      ? Math.ceil((cb.pauseUntil - Date.now()) / 60000)
      : 0,
    // Live signal & bet data
    lastSignal:    dash.lastSignal  ?? null,
    lastBet,
    lastResult:    dash.lastResult  ?? null,
    balance:       dash.balance     ?? null,
    session:       dash.session     ?? 'UNKNOWN',
    betMode:       dash.betMode     ?? 'martingale',
    activeAsset:   dash.activeAsset ?? 'btc',
    // Full live snapshot
    live:          dash,
    currentMarket,
    clobLatency,
    // Positions
    openPositions: Object.keys(positions).length,
    // Recent trades
    recentTrades,
    // Freshness
    updatedAt:   dash.updatedAt ?? null,
    serverTime:  new Date().toISOString(),
  });
});

// Positions detail
app.get('/api/positions', auth, (_req, res) => {
  const positions = readJson('positions.json') ?? {};
  res.json(Object.values(positions));
});

// Live dashboard snapshot
app.get('/api/live', auth, (_req, res) => {
  res.json(readJson('dashboard.json') ?? {});
});

// Stop bot
app.post('/api/stop', auth, (_req, res) => {
  exec('pm2 stop martingale-bot', (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, message: 'martingale-bot stopped' });
  });
});

app.listen(PORT, () => {
  console.log(`[Dashboard] Listening on http://localhost:${PORT}/?key=${DASHBOARD_KEY}`);
});
