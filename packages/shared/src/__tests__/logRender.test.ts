import { describe, expect, it } from 'bun:test';
import { LogLineRenderer, logTagBackground } from '../logRender';

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

describe('LogLineRenderer', () => {
  it('shows the time only, with a separator line whenever the day changes', () => {
    const r = new LogLineRenderer();
    const first = r.render('[2026-11-15 23:59:58] [INFO] [Bootstrap] up');
    const same = r.render('[2026-11-15 23:59:59] [INFO] [Bootstrap] still');
    const next = r.render('[2026-11-16 00:00:01] [INFO] [Bootstrap] tomorrow');
    expect(plain(first).split('\n')).toEqual(['──────── 2026-11-15 ────────', '23:59:58 INFO  Bootstrap up']);
    expect(plain(same)).toBe('23:59:59 INFO  Bootstrap still');
    expect(plain(next).split('\n')[0]).toBe('──────── 2026-11-16 ────────');
  });

  it('sets the first line of a context on its background, and only the tag after that', () => {
    const r = new LogLineRenderer();
    r.render('[2026-11-15 10:00:00] [INFO] warm up the date');
    const bg = logTagBackground('msg:ab12cd');
    const first = r.render('[2026-11-15 10:00:01] [INFO] [msg:ab12cd] [Pipeline] start');
    const later = r.render('[2026-11-15 10:00:02] [INFO] [msg:ab12cd] [Pipeline] done');
    expect(first).toContain(`\x1b[${bg};97m [msg:ab12cd] [Pipeline] start `);
    expect(later).toContain(`\x1b[${bg}m\x1b[97m[msg:ab12cd]`);
    expect(plain(later)).toBe('10:00:02 INFO  [msg:ab12cd] Pipeline done');
  });

  it('dims the stats marker instead of treating it as a module, and colours a warning', () => {
    const r = new LogLineRenderer();
    r.render('[2026-11-15 10:00:00] [INFO] [msg:x] first sight');
    const stats = r.render('[2026-11-15 10:00:01] [INFO] [msg:x] [STATS] ===>[Message] hi');
    expect(stats).toContain('\x1b[2m[STATS]');
    expect(r.render('[2026-11-15 10:00:02] [WARN] [Bootstrap] careful')).toContain('\x1b[33mcareful');
  });

  it('indents what follows an entry under its message, and sets part markers in bold', () => {
    const r = new LogLineRenderer();
    const out = r.render('[2026-11-15 10:00:00] [ERROR] [LLM] failed\n── [user] ──\n    at frame (a.ts:1)');
    const [, , marker, frame] = out.split('\n');
    expect(marker).toBe(`${' '.repeat(15)}\x1b[1m── [user] ──\x1b[0m`);
    expect(plain(frame)).toBe(`${' '.repeat(15)}    at frame (a.ts:1)`);
  });

  it('gives one tag one background', () => {
    expect(logTagBackground('msg:ab12cd')).toBe(logTagBackground('msg:ab12cd'));
  });
});
