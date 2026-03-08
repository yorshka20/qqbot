const path = require('path');

module.exports = {
  apps: [
    {
      name: 'qq-bot',
      script: 'bun',
      args: ['run', 'src/index.ts'],
      interpreter: 'none',
      cwd: path.resolve(__dirname),
      cron_restart: '0 */6 * * *',
      autorestart: true,
      env: {
        LOG_LEVEL: 'debug',
        NODE_ENV: 'development',
      },
    },
    {
      name: 'qq-bot-ui',
      script: 'bun',
      args: ['run', 'dev'],
      cwd: path.join(__dirname, 'webui'),
      interpreter: 'none',
      autorestart: true,
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
