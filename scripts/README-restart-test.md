# PM2 restart-from-within test

Proves that a process managed by PM2 can trigger its own restart using a **two-level spawn** and `--no-treekill`.

## How it works

- [test-pm2-restart.cjs](test-pm2-restart.cjs): runs under PM2 as `test-restart`. On start writes `started <timestamp>` to `/tmp/qqbot-restart-test.log`. On `GET http://localhost:39999/restart` it spawns [pm2-restart-helper.cjs](pm2-restart-helper.cjs) (detached), which runs `pm2 restart test-restart --no-treekill`. PM2 then kills the test process and starts a new one; the new process writes `started` again.
- [pm2-restart-helper.cjs](pm2-restart-helper.cjs): standalone script that runs `pm2 restart <apps> --no-treekill` in a detached child. Used so the process that runs `pm2` is not the direct child of the app being restarted.

Ecosystem has `treekill: false` for `test-restart` (and for `qq-bot` / `qq-bot-ui`) so PM2 does not kill the helper when it restarts the app.

## Run the test

```bash
# Clear log and start only test-restart
rm -f /tmp/qqbot-restart-test.log
pm2 start ecosystem.config.cjs --only test-restart

# Trigger restart
curl http://localhost:39999/restart

# After a few seconds, verify two "started" lines
sleep 4 && cat /tmp/qqbot-restart-test.log
# Expect: two lines like "started 2026-03-11T15:12:39.189Z" and "started 2026-03-11T15:12:45.896Z"

# Cleanup
pm2 delete test-restart
```

## Result

If the log contains at least two `started <ISO timestamp>` lines with different timestamps, the restart-from-within scheme works. The same pattern (spawn helper, helper runs `pm2 restart qq-bot qq-bot-ui --no-treekill`) is used in the `/restart` command.
