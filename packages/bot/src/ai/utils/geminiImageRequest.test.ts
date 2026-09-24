import { describe, expect, it } from 'bun:test';
import { assertGeminiReferenceCount, geminiImageConfig, GEMINI_IMAGE_MAX_REFERENCES } from './geminiImageRequest';

describe('geminiImageRequest', () => {
  it('accepts the documented reference-image maximum and rejects one past it', () => {
    expect(() => assertGeminiReferenceCount(GEMINI_IMAGE_MAX_REFERENCES)).not.toThrow();
    expect(() => assertGeminiReferenceCount(GEMINI_IMAGE_MAX_REFERENCES + 1)).toThrow(/at most 14/);
  });

  it('keeps only aspect ratio and image size the image API accepts', () => {
    expect(geminiImageConfig({ aspectRatio: '9:16', imageSize: '2k' })).toEqual({
      aspectRatio: '9:16',
      imageSize: '2K',
    });
    expect(geminiImageConfig({ aspectRatio: '2K', imageSize: '512' })).toBeUndefined();
    expect(geminiImageConfig()).toBeUndefined();
  });
});
