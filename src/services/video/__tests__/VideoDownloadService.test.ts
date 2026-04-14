import 'reflect-metadata';

import { afterEach, describe, expect, it, vi } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { ResourceDownloader } from '@/ai/utils/ResourceDownloader';
import { logger } from '@/utils/logger';
import { VideoDownloadService } from '../VideoDownloadService';

function createStream(text: string): ReadableStream<Uint8Array> {
  return (
    new Response(text).body ??
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    })
  );
}

function createProc(params: { exitCode: number; stdout?: string; stderr?: string }) {
  return {
    stdout: createStream(params.stdout ?? ''),
    stderr: createStream(params.stderr ?? ''),
    exited: Promise.resolve(params.exitCode),
    exitCode: params.exitCode,
    kill: vi.fn(),
  } as unknown as Bun.Subprocess;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VideoDownloadService', () => {
  it.each([
    ['https://www.bilibili.com/video/BV1xK4y1c7', 'bilibili'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
  ])('routes %s through yt-dlp when available', async (url) => {
    const spawn = vi.spyOn(Bun, 'spawn') as any;
    spawn.mockImplementation((args: any) => {
      const cmd = Array.isArray(args) ? args : (args.cmd ?? []);
      if (cmd[1] === '--version') {
        return createProc({ exitCode: 0, stdout: '2025.01.01' });
      }

      return createProc({ exitCode: 0 });
    });
    vi.spyOn(fsPromises, 'readFile').mockResolvedValue(Buffer.from('video-bytes'));
    vi.spyOn(fsPromises, 'mkdir').mockResolvedValue(undefined);
    const downloadToBase64 = vi.spyOn(ResourceDownloader, 'downloadToBase64');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const service = new VideoDownloadService();
    const result = await service.download(url);

    expect(downloadToBase64).not.toHaveBeenCalled();
    expect(result.buffer.equals(Buffer.from('video-bytes'))).toBe(true);
    expect(result.tempPath.endsWith('.mp4')).toBe(true);

    const downloadCall = spawn.mock.calls.find((call: any[]) => {
      const cmd = Array.isArray(call[0]) ? call[0] : (call[0]?.cmd ?? []);
      return cmd[0] === 'yt-dlp' && cmd.includes(url);
    });

    expect(downloadCall).toBeDefined();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('yt-dlp is unavailable'));
  });

  it('falls back to HTTP when yt-dlp is unavailable', async () => {
    const spawn = vi.spyOn(Bun, 'spawn') as any;
    spawn.mockImplementation((args: any) => {
      const cmd = Array.isArray(args) ? args : (args.cmd ?? []);
      if (cmd[1] === '--version') {
        return createProc({ exitCode: 127, stderr: 'yt-dlp: not found' });
      }

      return createProc({ exitCode: 127, stderr: 'yt-dlp: not found' });
    });
    vi.spyOn(fsPromises, 'mkdir').mockResolvedValue(undefined);
    const downloadToBase64 = vi
      .spyOn(ResourceDownloader, 'downloadToBase64')
      .mockResolvedValue(Buffer.from('http-bytes').toString('base64'));
    const write = vi.spyOn(Bun, 'write').mockResolvedValue(10 as never);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const service = new VideoDownloadService();
    const result = await service.download('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    expect(downloadToBase64).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(result.buffer.equals(Buffer.from('http-bytes'))).toBe(true);
    expect(
      spawn.mock.calls.filter((call: any[]) => {
        const cmd = Array.isArray(call[0]) ? call[0] : (call[0]?.cmd ?? []);
        return cmd[0] === 'yt-dlp';
      }),
    ).toHaveLength(1);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('yt-dlp is unavailable'))).toBe(true);
  });

  it('uses the HTTP path for generic URLs', async () => {
    const spawn = vi.spyOn(Bun, 'spawn') as any;
    spawn.mockImplementation((args: any) => {
      const cmd = Array.isArray(args) ? args : (args.cmd ?? []);
      if (cmd[1] === '--version') {
        return createProc({ exitCode: 0, stdout: '2025.01.01' });
      }

      return createProc({ exitCode: 0 });
    });
    vi.spyOn(fsPromises, 'mkdir').mockResolvedValue(undefined);
    const downloadToBase64 = vi
      .spyOn(ResourceDownloader, 'downloadToBase64')
      .mockResolvedValue(Buffer.from('generic-http').toString('base64'));
    vi.spyOn(Bun, 'write').mockResolvedValue(12 as never);

    const service = new VideoDownloadService();
    const result = await service.download('https://example.com/media/test.mp4');

    expect(downloadToBase64).toHaveBeenCalledTimes(1);
    expect(result.buffer.equals(Buffer.from('generic-http'))).toBe(true);
    expect(
      spawn.mock.calls.filter((call: any[]) => {
        const cmd = Array.isArray(call[0]) ? call[0] : (call[0]?.cmd ?? []);
        return cmd[0] === 'yt-dlp';
      }),
    ).toHaveLength(1);
  });

  it('spawns yt-dlp with the expected download arguments', async () => {
    const spawn = vi.spyOn(Bun, 'spawn') as any;
    spawn.mockImplementation((args: any) => {
      const cmd = Array.isArray(args) ? args : (args.cmd ?? []);
      if (cmd[1] === '--version') {
        return createProc({ exitCode: 0, stdout: '2025.01.01' });
      }

      return createProc({ exitCode: 0 });
    });
    vi.spyOn(fsPromises, 'readFile').mockResolvedValue(Buffer.from('yt-dlp-bytes'));
    vi.spyOn(fsPromises, 'mkdir').mockResolvedValue(undefined);

    const service = new VideoDownloadService();
    const result = await service.download('https://www.bilibili.com/video/BV1xK4y1c7', {
      maxSize: 200 * 1024 * 1024,
    });

    const downloadCall = spawn.mock.calls.find((call: any[]) => {
      const cmd = Array.isArray(call[0]) ? call[0] : (call[0]?.cmd ?? []);
      return cmd[0] === 'yt-dlp' && cmd.includes('https://www.bilibili.com/video/BV1xK4y1c7');
    });

    expect(downloadCall).toBeDefined();
    const cmd = downloadCall ? (Array.isArray(downloadCall[0]) ? downloadCall[0] : (downloadCall[0]?.cmd ?? [])) : [];
    expect(cmd).toContain('--max-filesize');
    expect(cmd).toContain('200M');
    expect(cmd).toContain('--merge-output-format');
    expect(cmd).toContain('mp4');
    expect(result.tempPath.endsWith('.mp4')).toBe(true);
  });
});
