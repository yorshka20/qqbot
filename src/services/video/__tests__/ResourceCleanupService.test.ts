import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import { ResourceCleanupService } from '../ResourceCleanupService';

const tempDirs: string[] = [];

async function createTempFile(prefix: string, name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  const filePath = join(dir, name);
  await writeFile(filePath, 'temp');
  return filePath;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('ResourceCleanupService', () => {
  it('registers remote files and cleans local and remote resources for a session', async () => {
    const service = new ResourceCleanupService();
    const localFile = await createTempFile('qqbot-resource-cleanup-', 'local.txt');
    const remoteDelete = vi.fn().mockResolvedValue(undefined);

    service.register('session-1', localFile);
    service.registerRemoteFile('session-1', 'files/test-video-id');

    await service.cleanup('session-1', remoteDelete);

    expect(remoteDelete).toHaveBeenCalledWith('files/test-video-id');
    await expect(access(localFile)).rejects.toThrow();
  });

  it('cleanupAll cleans every tracked session best-effort', async () => {
    const service = new ResourceCleanupService();
    const localFileA = await createTempFile('qqbot-resource-cleanup-a-', 'local-a.txt');
    const localFileB = await createTempFile('qqbot-resource-cleanup-b-', 'local-b.txt');
    const remoteDelete = vi.fn().mockResolvedValue(undefined);

    service.register('session-a', localFileA);
    service.registerRemoteFile('session-a', 'files/test-video-a');
    service.register('session-b', localFileB);
    service.registerRemoteFile('session-b', 'files/test-video-b');

    await service.cleanupAll(remoteDelete);

    expect(remoteDelete).toHaveBeenCalledTimes(2);
    expect(remoteDelete).toHaveBeenCalledWith('files/test-video-a');
    expect(remoteDelete).toHaveBeenCalledWith('files/test-video-b');
    await expect(access(localFileA)).rejects.toThrow();
    await expect(access(localFileB)).rejects.toThrow();
  });

  it('continues cleanupAll when one session fails to delete remote files', async () => {
    const service = new ResourceCleanupService();
    const localFileA = await createTempFile('qqbot-resource-cleanup-c-', 'local-c.txt');
    const localFileB = await createTempFile('qqbot-resource-cleanup-d-', 'local-d.txt');

    service.register('session-c', localFileA);
    service.registerRemoteFile('session-c', 'files/test-video-c');
    service.register('session-d', localFileB);
    service.registerRemoteFile('session-d', 'files/test-video-d');

    const remoteDelete = vi.fn().mockImplementation(async (fileName: string) => {
      if (fileName === 'files/test-video-c') {
        throw new Error('delete failed');
      }
    });

    await service.cleanupAll(remoteDelete);

    expect(remoteDelete).toHaveBeenCalledWith('files/test-video-c');
    expect(remoteDelete).toHaveBeenCalledWith('files/test-video-d');
    await expect(access(localFileA)).rejects.toThrow();
    await expect(access(localFileB)).rejects.toThrow();
  });
});
