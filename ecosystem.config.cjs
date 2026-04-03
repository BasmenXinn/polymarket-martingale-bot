module.exports = {
  apps: [
    {
      name:         'martingale-bot',
      script:       'src/martingale-bot.js',
      interpreter:  'node',
      // Pass --experimental flags if needed (not required on Node 18)
      node_args:    '',
      cwd:          '/root/polymarket-terminal',
      // Restart on crash, up to 10 times within 5 minutes
      autorestart:  true,
      max_restarts: 10,
      min_uptime:   '10s',
      restart_delay: 5000,
      // Environment — load from .env file automatically
      env: {
        NODE_ENV: 'production',
      },
      // Logging
      out_file:  '/root/polymarket-terminal/logs/martingale-out.log',
      error_file: '/root/polymarket-terminal/logs/martingale-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Keep logs manageable
      max_size:   '20M',
      retain:     7,
    },
  ],
};
