# Polymarket Terminal

An open-source automated trading terminal for [Polymarket](https://polymarket.com) — featuring a high-frequency maker rebate market maker, copy trading, and an orderbook sniper, all runnable from the command line.

**Created by [@direkturcrypto](https://twitter.com/direkturcrypto)**
**Repository:** https://github.com/direkturcrypto/polymarket-terminal

---

## Strategies

### 1. Maker Rebate MM (`npm run maker-mm-bot`) ⭐ Main Strategy

High-frequency market-making on Polymarket's 15-minute BTC/ETH/SOL Up-or-Down markets.

**How it works:**
1. Detects a new 15-minute market as it opens
2. Places maker limit BUY orders on both YES and NO sides simultaneously (combined ≈ $0.98)
3. When both sides fill, merges YES + NO tokens back to USDC via the CTF contract — capturing the spread as profit
4. Re-enters immediately after each successful merge for the duration of the market
5. Automatically queues the next market before the current one closes — zero idle time between markets

**Key design decisions:**
- **Never aggressive-reprices when one side is filled** — holds the original bid and waits for market reversion, preventing double exposure
- **Stops re-entry after a stuck (one-sided) cycle** — protects against accumulating directional exposure in trending markets
- **Combined cap always enforced** — cost of YES + NO never exceeds `MAKER_MM_MAX_COMBINED`, guaranteeing profitability on every successful merge
- **WebSocket real-time fill detection** — fills detected via RTDS WebSocket for sub-second response, with onchain balance as source of truth
- **Market-neutral** — profits from spread capture only, never depends on price direction

**Economics per cycle (default $5/side, 5 shares):**
```
Both sides fill → merge → recover $5.00 from $4.90 cost = +$0.10 profit per cycle
One side stuck  → hold original bid → wait for reversion or cut-loss at close
```

**Configuration (via `.env`):**
```
MAKER_MM_ASSETS=btc          # Assets: btc, eth, sol, xrp
MAKER_MM_DURATION=15m        # Market duration
MAKER_MM_TRADE_SIZE=5        # Shares per side
MAKER_MM_MAX_COMBINED=0.98   # Max combined bid (controls spread profit)
MAKER_MM_REENTRY_DELAY=30    # Seconds between cycles
CURRENT_MARKET_ENABLED=true  # Allow entering mid-market
CURRENT_MARKET_MAX_ODDS=0.70 # Skip if market is more skewed than this
```

---

### 2. Copy Trader (`npm run bot`)

Mirrors the trades of any target Polymarket wallet in real-time.

- Monitors target wallet for new BUY/SELL activity via the CLOB API
- Replicates trades proportionally using configurable sizing modes (`balance` or `percentage`)
- Supports automatic sell-out when target trader exits (market or limit)
- Auto-redeems resolved positions

```
TRADER_ADDRESS=0xTARGET_WALLET
SIZE_MODE=balance
SIZE_PERCENT=10
MAX_POSITION_SIZE=10
```

---

### 3. Orderbook Sniper (`npm run sniper`)

Places 3-tier GTC limit BUY orders at deep discount price levels to catch panic dumps.

- Deploys staggered orders at 3 price tiers (1¢, 2¢, 3¢) with weighted sizing (50% / 30% / 20%)
- Time-based sizing multipliers for peak trading hours
- Per-asset session schedules (UTC+8)
- Auto-pauses an asset after a win to avoid re-entering an already-resolved market

```
SNIPER_ASSETS=eth,sol,xrp
SNIPER_MAX_SHARES=15
SNIPER_MULTIPLIERS=21:00-00:00:1.41,06:00-12:00:0.85
```

---

## Requirements

- Node.js 18+
- A Polymarket account with a funded proxy wallet (USDC.e on Polygon)
- EOA private key for signing (the signing wallet does not need to hold funds)

---

## Installation

```bash
git clone https://github.com/direkturcrypto/polymarket-terminal.git
cd polymarket-terminal
npm install
cp .env.example .env
# Edit .env with your wallet keys and settings
```

---

## Quick Start

**Always test with simulation mode first:**

```bash
# Simulate maker MM — no real orders placed
npm run maker-mm-bot-sim

# Run live maker MM (recommended starting config)
MAKER_MM_TRADE_SIZE=5 MAKER_MM_REENTRY_DELAY=30 npm run maker-mm-bot

# Simulate copy trader
npm run bot-sim

# Run live copy trader
npm run bot

# Simulate orderbook sniper
npm run sniper-sim

# Run live sniper
npm run sniper
```

---

## Running with PM2 (recommended for VPS)

```bash
npm install -g pm2

# Start maker MM
pm2 start src/maker-mm-bot.js --name polymarket-maker-mm --interpreter node

# Start copy trader
pm2 start src/bot.js --name polymarket-bot --interpreter node

# View logs
pm2 logs polymarket-maker-mm
pm2 logs polymarket-bot
```

---

## Project Structure

```
src/
├── maker-mm-bot.js          # Maker Rebate MM — PM2/VPS entry point
├── maker-mm.js              # Maker Rebate MM — TUI entry point
├── bot.js                   # Copy Trader
├── sniper.js                # Orderbook Sniper
├── mm-bot.js                # Classic MM (legacy)
├── config/
│   └── index.js             # All configuration with env var mapping
└── services/
    ├── makerRebateExecutor.js   # Core maker MM logic (orders, fills, merge)
    ├── mmDetector.js            # Market discovery and scheduling
    ├── mmWsFillWatcher.js       # WebSocket RTDS real-time fill detection
    ├── ctf.js                   # CTF contract interaction (merge/redeem)
    └── client.js                # Polymarket CLOB client wrapper
```

---

## How Maker Rebate Works on Polymarket

Polymarket's CLOB gives **maker rebates** to traders who post limit orders, while takers pay a fee. This terminal exploits that by:

1. Simultaneously posting BUY limit orders on both YES and NO of a binary market
2. Since YES + NO always resolve to $1.00 (exactly one wins), buying both at combined cost < $1.00 guarantees a profit on merge
3. The position is closed by merging the token pair back into USDC via Polymarket's CTF contract — not by holding to resolution

This strategy is **market-neutral** and **direction-agnostic**. Profitability depends on fill rate and spread capture, not on predicting BTC price direction.

---

## Risk Management

- **No aggressive repricing**: after one side fills, the unfilled order stays at its original price — no chasing the market
- **Combined cap enforced**: YES + NO bids always ≤ `MAKER_MM_MAX_COMBINED` — a merge always returns more than it cost
- **One-sided stop**: if a cycle ends with only one side filled, re-entry for that market halts to prevent directional accumulation
- **Cut-loss**: all open orders are cancelled 60 seconds before market close
- **Odds filter**: skips re-entry if market odds exceed the configured threshold (default 70%)

---

## License

MIT — free to use, fork, and modify.

---

## Contributing

Pull requests are welcome. Open an issue for bugs or feature requests.

Built for the Polymarket ecosystem. Not affiliated with Polymarket.
