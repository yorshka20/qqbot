// Stand-in for the bot in Supervisor tests. Usage: fakeBot.ts <eventsFile> <mode>
//   serve        run until asked to shut down
//   crash        exit with code 1 right away
//   stubborn     ignore the shutdown request
//   ask-restart  on its first start, ask the supervisor for a restart; then serve
//   ask-deploy   on its first start, ask the supervisor for a deploy; then serve
//   grandchild   start a long-running child of its own; then serve
// Every event is appended to eventsFile as `<event> <pid> <epoch ms>`.

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const [eventsFile, mode] = process.argv.slice(2);
const record = (event: string, pid = process.pid) => appendFileSync(eventsFile, `${event} ${pid} ${Date.now()}\n`);
const firstStart = !existsSync(eventsFile) || !readFileSync(eventsFile, 'utf8').includes('start ');
record('start');

process.on('message', (message: { type: string }) => {
  if (message.type === 'shutdown' && mode !== 'stubborn') {
    record('shutdown');
    process.exit(0);
  }
});
process.on('disconnect', () => process.exit(0));

if (mode === 'crash') {
  setTimeout(() => process.exit(1), 50);
}
if (firstStart && (mode === 'ask-restart' || mode === 'ask-deploy')) {
  process.send?.({ type: mode === 'ask-restart' ? 'restart' : 'deploy' });
}
if (mode === 'grandchild') {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  record('grandchild', child.pid);
}
setInterval(() => {}, 1000);
