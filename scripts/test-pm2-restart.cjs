#!/usr/bin/env node
/**
 * Minimal test for "restart from within PM2 app": this script runs under PM2 (name: test-restart).
 * On start: appends "started <ISO timestamp>" to /tmp/qqbot-restart-test.log.
 * On GET http://localhost:39999/restart: spawns pm2-restart-helper.cjs to run "pm2 restart test-restart --no-treekill",
 * then responds "ok". PM2 will kill this process and start a new one; the new process writes "started" again.
 * Verify: log file has at least two "started" lines with different timestamps.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LOG_FILE = '/tmp/qqbot-restart-test.log';
const PORT = 39999;

function writeStarted() {
  const line = `started ${new Date().toISOString()}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log('[test-pm2-restart]', line.trim());
}

writeStarted();

const server = http.createServer((req, res) => {
  if (req.url === '/restart' && req.method === 'GET') {
    const scriptDir = path.resolve(__dirname);
    const helperPath = path.join(scriptDir, 'pm2-restart-helper.cjs');
    const child = spawn(process.execPath, [helperPath], {
      env: { ...process.env, RESTART_APP_NAMES: 'test-restart' },
      cwd: path.resolve(scriptDir, '..'),
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => {
      console.error('[test-pm2-restart] spawn helper error:', err.message);
      res.writeHead(500);
      res.end('spawn error');
      return;
    });
    child.unref();
    res.writeHead(200);
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[test-pm2-restart] listening http://localhost:${PORT}/restart`);
});
