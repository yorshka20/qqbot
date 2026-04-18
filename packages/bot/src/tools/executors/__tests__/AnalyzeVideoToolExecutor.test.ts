import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import type { AIManager } from '@/ai/AIManager';
import type { GeminiProvider } from '@/ai/providers/GeminiProvider';
import type { ResourceCleanupService, VideoDownloadResult, VideoDownloadService } from '@/services/video';
import type { ToolCall, ToolExecutionContext } from '@/tools/types';
import { AnalyzeVideoToolExecutor } from '../AnalyzeVideoToolExecutor';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FAKE_DOWNLOAD_RESULT: VideoDownloadResult = {
  buffer: Buffer.from('fake-video-bytes'),
  sessionId: 'test-session-123',
  tempPath: '/tmp/video_test-session-123.tmp',
};

function makeVideoDownloadService(overrides: Partial<VideoDownloadService> = {}): VideoDownloadService {
  return {
    download: vi.fn().mockResolvedValue(FAKE_DOWNLOAD_RESULT),
    ...overrides,
  } as unknown as VideoDownloadService;
}

function makeResourceCleanupService(overrides: Partial<ResourceCleanupService> = {}): ResourceCleanupService {
  return {
    register: vi.fn(),
    registerRemoteFile: vi.fn(),
    cleanup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ResourceCleanupService;
}

function makeGeminiProvider(overrides: Partial<GeminiProvider> = {}): GeminiProvider {
  return {
    name: 'gemini',
    uploadVideoFile: vi.fn().mockResolvedValue({
      name: 'files/test-video-id',
      uri: 'https://generativelanguage.googleapis.com/files/test-video-id',
      mimeType: 'video/mp4',
    }),
    waitForFileProcessing: vi.fn().mockResolvedValue({
      name: 'files/test-video-id',
      uri: 'https://generativelanguage.googleapis.com/files/test-video-id',
      state: 'ACTIVE',
      mimeType: 'video/mp4',
    }),
    generateWithFileUri: vi.fn().mockResolvedValue({
      text: '视频分析结果：这是一个关于编程教学的短视频。',
    }),
    deleteUploadedFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GeminiProvider;
}

function makeAIManager(geminiProvider: GeminiProvider): AIManager {
  return {
    getProvider: vi.fn().mockReturnValue(geminiProvider),
  } as unknown as AIManager;
}

function makeExecutor(
  geminiOverrides: Partial<GeminiProvider> = {},
  vdsOverrides: Partial<VideoDownloadService> = {},
  rcsOverrides: Partial<ResourceCleanupService> = {},
): {
  executor: AnalyzeVideoToolExecutor;
  gemini: GeminiProvider;
  vds: VideoDownloadService;
  rcs: ResourceCleanupService;
} {
  const gemini = makeGeminiProvider(geminiOverrides);
  const aiManager = makeAIManager(gemini);
  const vds = makeVideoDownloadService(vdsOverrides);
  const rcs = makeResourceCleanupService(rcsOverrides);
  const executor = new AnalyzeVideoToolExecutor(aiManager, vds, rcs);
  return { executor, gemini, vds, rcs };
}

const defaultToolCall: ToolCall = {
  type: 'analyze_video',
  parameters: { url: 'https://example.com/video.mp4', prompt: '分析视频内容' },
  executor: 'analyze_video',
};

const defaultContext: ToolExecutionContext = {
  userId: 123,
  groupId: 456,
  messageType: 'group',
  conversationId: 'conv-1',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AnalyzeVideoToolExecutor', () => {
  // ── Tool metadata ──────────────────────────────────────────────────────────

  describe('tool metadata', () => {
    it('tool name is analyze_video', () => {
      const { executor } = makeExecutor();
      expect(executor.name).toBe('analyze_video');
    });
  });

  // ── Parameter validation ───────────────────────────────────────────────────

  describe('parameter validation', () => {
    it('returns error when url is missing', async () => {
      const { executor } = makeExecutor();
      const result = await executor.execute({ ...defaultToolCall, parameters: { prompt: '分析' } }, defaultContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('url');
    });
  });

  // ── Success path ───────────────────────────────────────────────────────────

  describe('success path', () => {
    it('returns analysis result with analysisText in data', async () => {
      const { executor } = makeExecutor();
      const result = await executor.execute(defaultToolCall, defaultContext);
      expect(result.success).toBe(true);
      expect(result.data?.analysisText).toBeDefined();
      expect(result.data?.analysisText).toContain('视频分析结果');
    });

    it('passes prompt through to data', async () => {
      const { executor } = makeExecutor();
      const result = await executor.execute(defaultToolCall, defaultContext);
      expect(result.data?.prompt).toBe('分析视频内容');
    });

    it('calls uploadVideoFile with the downloaded buffer', async () => {
      const { executor, gemini } = makeExecutor();
      await executor.execute(defaultToolCall, defaultContext);
      expect(gemini.uploadVideoFile).toHaveBeenCalledWith(FAKE_DOWNLOAD_RESULT.buffer, 'video/mp4');
    });

    it('calls generateWithFileUri with the processed fileUri (no re-upload)', async () => {
      const { executor, gemini } = makeExecutor();
      await executor.execute(defaultToolCall, defaultContext);
      // Must use generateWithFileUri, NOT generateWithVideo (which would re-upload)
      expect(gemini.generateWithFileUri).toHaveBeenCalledWith(
        '分析视频内容',
        'https://generativelanguage.googleapis.com/files/test-video-id',
        'video/mp4',
        expect.objectContaining({ maxTokens: 2000 }),
      );
    });
  });

  // ── Download failure ───────────────────────────────────────────────────────

  describe('download failure', () => {
    it('returns error when video download fails', async () => {
      const { executor } = makeExecutor({}, { download: vi.fn().mockRejectedValue(new Error('network error')) });
      const result = await executor.execute(defaultToolCall, defaultContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Video download failed');
    });
  });

  // ── Upload / analysis failure ──────────────────────────────────────────────

  describe('upload failure', () => {
    it('returns error when Gemini upload fails', async () => {
      const { executor } = makeExecutor({
        uploadVideoFile: vi.fn().mockRejectedValue(new Error('quota exceeded')),
      });
      const result = await executor.execute(defaultToolCall, defaultContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Gemini upload failed');
    });
  });

  describe('processing failure', () => {
    it('returns error when Gemini file processing fails', async () => {
      const { executor } = makeExecutor({
        waitForFileProcessing: vi.fn().mockRejectedValue(new Error('processing timed out')),
      });
      const result = await executor.execute(defaultToolCall, defaultContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Gemini file processing failed');
    });
  });

  describe('analysis failure', () => {
    it('returns error when Gemini analysis fails', async () => {
      const { executor } = makeExecutor({
        generateWithFileUri: vi.fn().mockRejectedValue(new Error('model error')),
      });
      const result = await executor.execute(defaultToolCall, defaultContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Gemini analysis failed');
    });
  });

  // ── Cleanup in finally block ───────────────────────────────────────────────

  describe('cleanup in finally block', () => {
    it('registers temp path with ResourceCleanupService before processing', async () => {
      const { executor, rcs } = makeExecutor();
      await executor.execute(defaultToolCall, defaultContext);
      expect(rcs.register).toHaveBeenCalledWith('test-session-123', '/tmp/video_test-session-123.tmp');
    });

    it('registers the Gemini file with ResourceCleanupService after upload', async () => {
      const { executor, rcs } = makeExecutor();
      await executor.execute(defaultToolCall, defaultContext);
      expect(rcs.registerRemoteFile).toHaveBeenCalledWith('test-session-123', 'files/test-video-id');
    });

    it('calls ResourceCleanupService.cleanup with a delete callback on success', async () => {
      const { executor, rcs } = makeExecutor();
      await executor.execute(defaultToolCall, defaultContext);
      expect(rcs.cleanup).toHaveBeenCalledWith('test-session-123', expect.any(Function));
    });

    it('calls ResourceCleanupService.cleanup even when analysis throws', async () => {
      const { executor, rcs } = makeExecutor({
        generateWithFileUri: vi.fn().mockRejectedValue(new Error('analysis crash')),
      });
      await executor.execute(defaultToolCall, defaultContext);
      expect(rcs.cleanup).toHaveBeenCalledWith('test-session-123', expect.any(Function));
    });

    it('calls ResourceCleanupService.cleanup even when upload fails', async () => {
      const { executor, rcs } = makeExecutor({
        uploadVideoFile: vi.fn().mockRejectedValue(new Error('upload error')),
      });
      await executor.execute(defaultToolCall, defaultContext);
      // sessionId is set before upload, so cleanup is still called
      expect(rcs.cleanup).toHaveBeenCalledWith('test-session-123', expect.any(Function));
    });

    it('does not delete the Gemini file directly before cleanup runs', async () => {
      const cleanup = vi.fn().mockResolvedValue(undefined);
      const { executor, gemini } = makeExecutor({}, {}, { cleanup });
      await executor.execute(defaultToolCall, defaultContext);
      expect(cleanup).toHaveBeenCalledWith('test-session-123', expect.any(Function));
      expect(gemini.deleteUploadedFile).not.toHaveBeenCalled();
    });

    it('deletes the Gemini file through the cleanup callback path', async () => {
      const cleanup = vi
        .fn()
        .mockImplementation(async (_sessionId: string, deleteRemoteFile?: (fileName: string) => Promise<void>) => {
          if (deleteRemoteFile) {
            await deleteRemoteFile('files/test-video-id');
          }
        });
      const { executor, gemini } = makeExecutor({}, {}, { cleanup });
      await executor.execute(defaultToolCall, defaultContext);
      expect(cleanup).toHaveBeenCalledWith('test-session-123', expect.any(Function));
      expect(gemini.deleteUploadedFile).toHaveBeenCalledWith('files/test-video-id');
    });
  });

  // ── Preset configuration ───────────────────────────────────────────────────

  describe('video_analyzer preset', () => {
    it('getRolePreset returns gemini providerName for video_analyzer', async () => {
      const { getRolePreset } = await import('@/agent/SubAgentRolePresets');
      const preset = getRolePreset('video_analyzer');
      expect(preset.configOverrides.providerName).toBe('gemini');
      expect(preset.displayName).toBe('视频分析');
    });

    it('getRolePreset returns non-generic config for video_analyzer', async () => {
      const { getRolePreset } = await import('@/agent/SubAgentRolePresets');
      const preset = getRolePreset('video_analyzer');
      expect(preset.displayName).not.toBe('后台任务');
    });

    it('video_analyzer preset has a generous timeout', async () => {
      const { getRolePreset } = await import('@/agent/SubAgentRolePresets');
      const preset = getRolePreset('video_analyzer');
      // Must be at least 5 minutes (300 000 ms) to handle slow video processing
      expect(preset.configOverrides.timeout).toBeGreaterThan(300_000);
    });

    it('video_analyzer preset allows tool rounds (analyze_video must be callable)', async () => {
      const { getRolePreset } = await import('@/agent/SubAgentRolePresets');
      const preset = getRolePreset('video_analyzer');
      // maxToolRounds must be > 0 so the subagent can call analyze_video
      const maxToolRounds = preset.configOverrides.maxToolRounds as number | undefined;
      expect(maxToolRounds == null || maxToolRounds > 0).toBe(true);
    });
  });
});
