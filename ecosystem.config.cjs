const path = require('path');

// restart_delay: 60s between restarts; max_restarts: high so PM2 retries every minute on start failure until success.
module.exports = {
  apps: [
    {
      name: 'qq-bot',
      script: path.join(__dirname, 'scripts/pm2-bot.sh'),
      args: [],
      interpreter: 'none',
      cwd: path.resolve(__dirname),
      autorestart: true,
      restart_delay: 60000,
      max_restarts: 999999,
      treekill: false,
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
      treekill: false,
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
