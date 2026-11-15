import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveSpaFile } from '../http/spaFiles';

const dir = mkdtempSync(join(tmpdir(), 'spa-files-'));
mkdirSync(join(dir, 'assets'));
writeFileSync(join(dir, 'index.html'), '<html>app</html>');
writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const get = (path: string, accept = '*/*') =>
  serveSpaFile(dir, path, new Request(`http://ui${path}`, { headers: { accept } }));

describe('serveSpaFile', () => {
  test('serves a file, and index.html at the root', async () => {
    expect(await get('/assets/app.js')?.text()).toBe('console.log(1)');
    expect(await get('/')?.text()).toBe('<html>app</html>');
  });

  test('a navigation to a client route falls back to index.html; a JSON request does not', async () => {
    expect(await get('/t/some-task', 'text/html')?.text()).toBe('<html>app</html>');
    expect(get('/api/unknown', 'application/json')).toBeNull();
    expect(get('/missing.js', 'text/html')).toBeNull();
  });

  test('nothing outside the directory, nothing but GET and HEAD, nothing when the build is absent', () => {
    expect(get('/../../etc/passwd', 'text/html')).toBeNull();
    expect(serveSpaFile(dir, '/', new Request('http://ui/', { method: 'POST' }))).toBeNull();
    expect(serveSpaFile(join(dir, 'absent'), '/', new Request('http://ui/'))).toBeNull();
  });
});
