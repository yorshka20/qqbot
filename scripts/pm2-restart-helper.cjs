#!/usr/bin/env node
/**
 * Standalone helper: run "pm2 stop <apps>", wait 5s for file handles to be released,
 * then "pm2 start <apps>". The gap between kill and start avoids restart failures
 * (e.g. node_modules still locked / EEXIST).
 * Usage: RESTART_APP_NAMES=app1,app2 node scripts/pm2-restart-helper.cjs
 *    or: node scripts/pm2-restart-helper.cjs app1 app2
 */

const { spawn } = require('child_process');

/** Delay between pm2 stop and pm2 start so the killed process releases files */
const GAP_AFTER_STOP_MS = 5000;

const names = process.env.RESTART_APP_NAMES
  ? process.env.RESTART_APP_NAMES.split(',').map((s) => s.trim()).filter(Boolean)
  : process.argv.slice(2).filter(Boolean);

if (names.length === 0) {
  console.error('Usage: RESTART_APP_NAMES=app1,app2 node pm2-restart-helper.cjs');
  process.exit(1);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('pm2', [cmd, ...names, ...args], {
      env: process.env,
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

async function main() {
  try {
    await run('stop', []);
    setTimeout(async () => {
      try {
        await run('start', []);
        process.exit(0);
      } catch (err) {
        console.error('[pm2-restart-helper] pm2 start error:', err.message);
        process.exit(1);
      }
    }, GAP_AFTER_STOP_MS);
  } catch (err) {
    console.error('[pm2-restart-helper] pm2 stop error:', err.message);
    process.exit(1);
  }
}

main();
