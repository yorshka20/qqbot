const path = require('path');

module.exports = {
  apps: [
    {
      name: 'qq-bot',
      script: path.join(__dirname, 'scripts/pm2-bot.sh'),
      args: [],
      interpreter: 'none',
      cwd: path.resolve(__dirname),
      cron_restart: '0 */6 * * *',
      autorestart: true,
      // On each start/restart: script runs git pull, bun install, then starts bot (remote fix → retry picks up)
      restart_delay: 60000,
      max_restarts: 999999,
      env: {
        LOG_LEVEL: 'debug',
        NODE_ENV: 'development',
      },
    },
    {
      name: 'qq-bot-ui',
      script: path.join(__dirname, 'scripts/pm2-ui.sh'),
      args: [],
      interpreter: 'none',
      cwd: path.resolve(__dirname),
      autorestart: true,
      restart_delay: 60000,
      max_restarts: 999999,
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
