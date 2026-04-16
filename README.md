```
██████╗  ██████╗ ██╗  ██╗   ██╗███╗   ███╗ █████╗ ██████╗ ██╗  ██╗███████╗████████╗
██╔══██╗██╔═══██╗██║  ╚██╗ ██╔╝████╗ ████║██╔══██╗██╔══██╗██║ ██╔╝██╔════╝╚══██╔══╝
██████╔╝██║   ██║██║   ╚████╔╝ ██╔████╔██║███████║██████╔╝█████╔╝ █████╗     ██║
██╔═══╝ ██║   ██║██║    ╚██╔╝  ██║╚██╔╝██║██╔══██║██╔══██╗██╔═██╗ ██╔══╝     ██║
██║     ╚██████╔╝███████╗██║   ██║ ╚═╝ ██║██║  ██║██║  ██║██║  ██╗███████╗   ██║
╚═╝      ╚═════╝ ╚══════╝╚═╝   ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝   ╚═╝

                     BTC 5M PREDICTOR — MARTINGALE BOT V2
              Automated ensemble trading for Polymarket prediction markets
```

# 🤖 Polymarket Martingale Bot V2

![Node.js](https://img.shields.io/badge/Node.js-v18%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![PM2](https://img.shields.io/badge/PM2-Process%20Manager-2B037A?style=flat-square&logo=pm2&logoColor=white)
![Polymarket](https://img.shields.io/badge/Polymarket-CLOB%20API-6C47FF?style=flat-square)
![Binance](https://img.shields.io/badge/Binance-Market%20Data-F0B90B?style=flat-square&logo=binance&logoColor=black)
![OpenRouter](https://img.shields.io/badge/OpenRouter-10%20LLM%20Models-FF6B35?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

---

## 📊 Overview

A fully automated trading bot for **Polymarket BTC 5-minute Up/Down prediction markets**. The bot uses a **9-signal ensemble voting system** combining on-chain orderbook data, technical analysis, price action, momentum, and AI predictions to determine the optimal direction (UP/DOWN) for each 5-minute candle.

Built with resilience in mind: circuit breaker protection, session-based confidence thresholds, multi-mode bet sizing, and real-time Telegram control — all visible through a live trading terminal dashboard.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🧠 **Multi-signal ensemble** | 9 independent signals voted into a single direction |
| 💰 **3 bet modes** | Martingale (double on loss), Flat (fixed), Kelly (dynamic sizing) |
| 🛡️ **Circuit breaker** | Auto-pauses after 3/4/5/6 consecutive losses (5m/15m/1h/24h) |
| 📊 **Web dashboard** | Real-time trading terminal with live orderbook, signals, and trade history |
| 📱 **Telegram bot** | Full bot control and notifications via Telegram commands |
| 🔁 **Auto redeem** | Automatically claims resolved positions on-chain |
| 🌍 **Multi-market mode** | Manual Sports & Politics market trading alongside BTC automation |
| 📈 **Price action signals** | Binance 1m candles — % change from market open |
| ⚡ **Momentum signals** | 5-candle momentum on Binance 1m data |
| 🤖 **LLM analysis** | 10 rotating OpenRouter models with automatic 429/404 fallback |
| 🕐 **Session thresholds** | PRIME/OKAY/RESTRICTED windows with adaptive confidence floors |
| 📅 **Daily loss limit** | Pauses until midnight UTC after 20% daily drawdown |

---

## 🧠 Signal Stack

The bot aggregates 9 independent signals into a majority vote. Signals that return `null` (no conviction) are excluded from the count — random noise is never injected.

| # | Signal | Source | Logic |
|---|--------|--------|-------|
| 1 | **Orderbook** | Polymarket CLOB | Mid price < 0.48 → NO, > 0.52 → YES |
| 2 | **LLM** | OpenRouter (10 models) | AI reads market name + mid price → YES/NO |
| 3 | **Extreme** | Polymarket CLOB | Mid < 0.25 → YES, > 0.75 → NO (contrarian) |
| 4 | **Reversal** | Trade history | 3× same side + stretched mid → fade the trend |
| 5 | **PriceAction** | Binance 1m | % change from market open (±0.08% threshold) |
| 6 | **Momentum** | Binance 1m | 5-candle price change (±0.10% threshold) |
| 7 | **RSI** | Binance 5m | RSI(7) < 22 → YES (oversold), > 78 → NO (overbought) |
| 8 | **Bollinger Bands** | Binance 5m | Price ≤ lower band → YES, ≥ upper band → NO |
| 9 | **Rejection Wick** | Binance 5m | Hammer candle → YES, Shooting star → NO |

Final direction = majority of non-null votes. Ties resolve to the orderbook signal.

---

## 🕐 Session Windows

Trading confidence thresholds adapt to market session quality:

| Session | UTC Hours | Base Confidence | Recovery Confidence |
|---------|-----------|-----------------|---------------------|
| 🟢 **PRIME** | 01:00 – 07:00 | 0.33 | 0.65 |
| 🟡 **OKAY** | 07:00 – 13:00 | 0.55 | 0.67 |
| 🔴 **RESTRICTED** | 13:00 – 01:00 | 0.65 | 0.67 |

---

## 🛡️ Circuit Breaker

| Consecutive Losses | Pause Duration |
|--------------------|----------------|
| 3 | 5 minutes |
| 4 | 15 minutes |
| 5 | 1 hour |
| 6+ | 24 hours |

State persists to `data/circuit-breaker.json` — survives PM2 restarts.

---

## 🎮 Telegram Commands

### 📊 Status & Info

| Command | Description |
|---------|-------------|
| `/status` | Full bot status: step, mode, session, PnL, streak, pause timer |
| `/pnl` | Last 10 trades with outcome and PnL |
| `/asset` | Currently active trading asset |
| `/dashboard` | Rich stats summary + link to web dashboard |

### 🎮 Bot Control

| Command | Description |
|---------|-------------|
| `/start` | Resume bot after stop |
| `/stop` | Gracefully stop the bot via PM2 |
| `/reset` | Reset all state, PnL, step counter, and circuit breaker |

### 🎯 Side Mode

| Command | Description |
|---------|-------------|
| `/yes` | Force all bets to YES (override signals) |
| `/no` | Force all bets to NO (override signals) |
| `/auto` | Resume signal-based direction (default) |

### 💰 Bet Mode

| Command | Description |
|---------|-------------|
| `/martingale` | Double bet on every loss (default) |
| `/flat` | Fixed bet size, no doubling |
| `/kelly` | Dynamic sizing based on rolling 20-trade win rate |
| `/bet1` – `/bet5` | Set flat bet size ($1–$5, flat mode only) |

### 📈 Market Selection

| Command | Description |
|---------|-------------|
| `/btc` | Switch to Bitcoin 5m (always immediate, restarts detector) |
| `/btc15` | Switch to Bitcoin 15m |
| `/sol` | Switch to Solana 5m |
| `/eth` | Switch to Ethereum 5m |
| `/xrp` | Switch to XRP 5m |
| `/doge` | Switch to Dogecoin 5m |

### 🌍 Multi-Market Manual Mode

| Command | Description |
|---------|-------------|
| `/mode btc` | Automatic BTC trading mode (default) |
| `/mode sports` | Enable manual sports market betting |
| `/mode politics` | Enable manual politics market betting |
| `/search <keyword>` | Search Polymarket for active events |
| `/pick <number>` | Select a market from search results |
| `/analyze` | Run LLM analysis on selected market |
| `/bet yes` / `/bet no` | Execute manual bet on selected market |

### 🔧 Tools

| Command | Description |
|---------|-------------|
| `/redeem` | Manually trigger position claim check |
| `/help` | Show full command reference |

---

## 📱 Dashboard

A dark trading terminal UI served on port 3000.

**URL:** `http://YOUR_VPS_IP:3000/?key=polymarket`

| Panel | Contents |
|-------|----------|
| **Header** | Total PnL, W/L record, current balance, STOP button |
| **Latency bar** | Binance API latency, CLOB freshness, ML status, market countdown |
| **Prediction** | Current UP/DOWN call, confidence bar, ENSEMBLE badge |
| **Reasoning** | All signal votes with +/−/~ prefix per signal |
| **Order Book** | Live BTC price, 6-level bid/ask depth with proportional bar fill |
| **Features** | fvUp, fvDown, obi20, depthR, mom30s, vol, gapUp, gapDown |
| **Trades table** | Time (WIB), direction, price, size, confidence, PnL, claim amount |
| **Footer** | Circuit breaker status, daily trade count, current step |

The dashboard fetches `/api/stats` and `/api/binance` every 3 seconds and renders without page reload.

---

## 🚀 Setup

### Prerequisites

- Node.js v18+
- PM2 (`npm install -g pm2`)
- Polymarket account with USDC.e deposited to your proxy wallet
- Telegram bot token + chat ID ([@BotFather](https://t.me/BotFather))
- OpenRouter API key — free tier works ([openrouter.ai](https://openrouter.ai))

### Installation

```bash
# 1. Clone the repository
git clone <repo-url>
cd polymarket-terminal

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
nano .env          # fill in PRIVATE_KEY, PROXY_WALLET_ADDRESS,
                   # TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, OPENROUTER_API_KEY

# 4. Create data directory
mkdir -p data

# 5. Start the trading bot
pm2 start src/martingale-bot.js --name martingale-bot

# 6. Start the dashboard server
pm2 start dashboard/server.js --name dashboard

# 7. Persist PM2 across reboots
pm2 save
pm2 startup        # run the printed command as root
```

### View Logs

```bash
pm2 logs martingale-bot       # live bot output
pm2 logs martingale-bot --err # errors only
pm2 logs dashboard            # dashboard server logs
pm2 status                    # process table
```

### First Run Checklist

```bash
# Always test with DRY_RUN=true first (default)
DRY_RUN=true   # in .env — simulates orders, no real money

# Watch for these log lines on startup:
# ✅ SUCCESS  Client initialised
# ℹ️  INFO    MM detector started — assets: BTC | duration: 5m
# ℹ️  INFO    [V2] Starting balance: $X.XX
# ✅ SUCCESS  MM: BTC found "Bitcoin Up or Down - ..." — entering
```

---

## ⚙️ Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | EOA private key for signing orders (does NOT hold funds) |
| `PROXY_WALLET_ADDRESS` | Polymarket proxy wallet — your deposit address |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your Telegram user or chat ID |

### Optional but Recommended

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | — | Enables LLM signal via 10 free rotating models |
| `POLYGON_RPC_URL` | `https://polygon.lava.build` | Polygon RPC for on-chain redemption |
| `DASHBOARD_KEY` | `polymarket` | Dashboard access key (`?key=...`) |
| `PORT` | `3000` | Dashboard HTTP port |
| `PROXY_URL` | — | HTTP/SOCKS5 proxy for Polymarket API calls |

### Bot Behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `DRY_RUN` | `true` | Simulate without placing real orders |
| `MARTINGALE_BASE_SIZE` | `1` | Base bet size in USDC |
| `MARTINGALE_MULTIPLIER` | `2` | Loss multiplier in martingale mode |
| `MARTINGALE_MAX_STEPS` | `5` | Max doubling steps before auto-reset |
| `MARTINGALE_ASSETS` | `btc` | Asset(s) to trade (comma-separated) |
| `MARTINGALE_DURATION` | `5m` | Market duration to target (`5m` or `15m`) |
| `MARTINGALE_RESET_ON_WIN` | `true` | Reset step counter to 0 on a win |
| `BALANCE_ALERT_THRESHOLD` | `25` | Telegram alert when balance reaches this USDC value |
| `REDEEM_INTERVAL` | `60` | Seconds between auto-redeem checks |

---

## 🏗️ Architecture

```
polymarket-terminal/
│
├── src/
│   ├── martingale-bot.js         # Main bot — signals, betting, Telegram commands
│   ├── config/
│   │   └── index.js              # Shared runtime config (assets, duration, etc.)
│   └── services/
│       ├── martingale.js         # Bet sizing, state persistence, outcome registration
│       ├── redeemer.js           # Auto-claim resolved positions on-chain
│       ├── telegram.js           # Telegram polling + send/notify helpers
│       ├── client.js             # Polymarket CLOB client init + USDC balance query
│       ├── mmDetector.js         # Market slot detector (5m/15m timing grid)
│       └── position.js           # Open position tracking (in-memory + file)
│
├── dashboard/
│   ├── server.js                 # Express API: /api/stats /api/binance /api/stop
│   └── index.html                # Dark trading terminal UI (vanilla JS, no framework)
│
├── data/                         # Runtime state — created automatically (gitignored)
│   ├── martingale-state.json     # Current step, full trade history
│   ├── positions.json            # Open positions awaiting on-chain redemption
│   ├── dashboard.json            # Live signal snapshot written each cycle
│   └── circuit-breaker.json     # Pause state + consecutive loss count
│
├── .env                          # Secrets — never commit this file
└── package.json
```

---

## 📈 Strategy

### Signal Voting

Each market cycle the bot independently fetches up to 9 signals. Signals with no conviction return `null` and are excluded from the vote. The final direction is determined by majority:

```
Signals:    OB=YES  LLM=NO  Extreme=null  Reversal=null
            PA=YES  Mom=YES  RSI=YES  BB=null  Wick=null

Non-null:   YES=4   NO=1
Decision:   → BET YES  (4v1 majority)
```

### Confidence Gate

Before placing a bet, `advSignal.confidence` (from RSI + BB + Wick) must meet the session minimum. If it falls short, the bot still bets — but uses only `smartSide` (orderbook + LLM + extreme + reversal + priceAction + momentum) rather than the full 9-signal vote.

### Martingale Progression

```
Step 0  →  $1.00   (base bet)
Step 1  →  $2.00   (after 1 loss)
Step 2  →  $4.00   (after 2 losses)
Step 3  →  $8.00   (after 3 losses)
Step 4  →  $16.00  (after 4 losses)
Step 5  →  $32.00  (max — auto-resets after 2 consecutive losses at max)
```

A single win at any step recoups all prior losses plus a small profit. The circuit breaker prevents runaway sequences by forcing a cooling-off pause.

### Entry Timing

The bot uses **delayed entry** — if a market has more than 5 minutes remaining on open, it waits up to 60 seconds for the orderbook to stabilize before committing. PriceAction signals additionally require the market to have been live for at least 90 seconds.

### Flat & Kelly Modes

- **Flat** — Fixed dollar bet, no compounding. Best for live testing on a fixed budget.
- **Kelly** — Fraction `= winRate − (1 − winRate)` clamped to 5%–25% of current balance, recalculated from the last 20 trades on every cycle.

---

## ☀️ Morning Briefing

Every day at **00:00 UTC (07:00 WIB)** the bot sends a Telegram summary:

- Last 24h bets, wins, losses, win rate, PnL
- All-time totals and win rate
- Current balance, open positions, active step
- Daily counters automatically reset after the briefing

---

## ⚠️ Disclaimer

> **This software is provided for educational and research purposes only.**
>
> Trading prediction markets involves significant financial risk. Past performance does not guarantee future results. The martingale strategy amplifies losses during consecutive losing streaks and can lead to rapid capital loss. Never trade with funds you cannot afford to lose entirely.
>
> The authors and contributors accept no responsibility for any financial losses incurred from using this software. Always verify behavior with `DRY_RUN=true` before enabling live trading.

---

## 📄 License

MIT © 2025

---

<div align="center">
  <sub>Built with ☕ and too many hours watching BTC 5m candles</sub>
</div>
