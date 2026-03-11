#!/usr/bin/env node
/**
 * Standalone helper: run "pm2 restart <apps> --no-treekill" in a detached child.
 * Used so the process that runs pm2 is not the direct child of the app being restarted
 * (avoids the child being killed before the restart command completes).
 * Usage: RESTART_APP_NAMES=app1,app2 node scripts/pm2-restart-helper.cjs
 *    or: node scripts/pm2-restart-helper.cjs app1 app2
 */

const { spawn } = require('child_process');

const names = process.env.RESTART_APP_NAMES
  ? process.env.RESTART_APP_NAMES.split(',').map((s) => s.trim()).filter(Boolean)
  : process.argv.slice(2).filter(Boolean);

if (names.length === 0) {
  console.error('Usage: RESTART_APP_NAMES=app1,app2 node pm2-restart-helper.cjs');
  process.exit(1);
}

const child = spawn(
  'pm2',
  ['restart', ...names, '--no-treekill'],
  {
    env: process.env,
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
  },
);

child.on('error', (err) => {
  console.error('[pm2-restart-helper] spawn error:', err.message);
  process.exit(1);
});

child.unref();
process.exit(0);
