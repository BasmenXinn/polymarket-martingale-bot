# Polymarket Martingale Bot 🤖

Automated Martingale trading bot for Polymarket BTC 5-minute markets.

## Features
- Auto-detects BTC Up/Down markets every 5 minutes
- Martingale strategy (doubles bet after loss, resets after win)
- Smart side selection using Binance BTC momentum analysis
- Telegram monitoring with real-time notifications
- Auto-claim winning positions on-chain
- Runs 24/7 on VPS via PM2

## Setup
1. Clone this repo
2. Run: `npm install`
3. Copy `.env.example` to `.env` and fill in your values
4. Run: `npm run martingale`
5. Or with PM2: `pm2 start ecosystem.config.cjs`

## Telegram Commands
- `/status` - Show current step, PnL, wins/losses
- `/pnl` - Show last 10 trades
- `/stop` - Stop the bot

## Requirements
- Node.js 18+
- Polymarket account with USDC deposited
- Polygon wallet with private key
- Telegram bot token
