module.exports = {
  apps: [{
    name: "qq-bot",
    script: "./start.sh",
		interpreter: "bash",
		// restart every 6 hours
    cron_restart: "0 */6 * * *",
    autorestart: true,
    env: {
      LOG_LEVEL: "DEBUG",
      NODE_ENV: "development"
    }
  }]
};
