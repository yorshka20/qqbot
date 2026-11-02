// Shared generateContent image-edit contract for GeminiProvider and LaozhangProvider.
// One user turn: a text part, then one inline image part per reference.
// Gemini 3 image models reject more than 14.
// https://ai.google.dev/gemini-api/docs/image-generation

export const GEMINI_IMAGE_MAX_REFERENCES = 14;

const ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '3:2', '2:3', '5:4', '4:5']);
const IMAGE_SIZES = new Set(['1K', '2K', '4K']);

export function assertGeminiReferenceCount(count: number): void {
  if (count > GEMINI_IMAGE_MAX_REFERENCES) {
    throw new Error(
      `Gemini image models accept at most ${GEMINI_IMAGE_MAX_REFERENCES} reference images (got ${count})`,
    );
  }
}

/** Fields the image API actually reads. Pixel width/height are not part of this request. */
export function geminiImageConfig(options?: {
  aspectRatio?: string;
  imageSize?: string;
}): { aspectRatio?: string; imageSize?: string } | undefined {
  const imageConfig: { aspectRatio?: string; imageSize?: string } = {};
  if (options?.aspectRatio && ASPECT_RATIOS.has(options.aspectRatio)) {
    imageConfig.aspectRatio = options.aspectRatio;
  }
  if (options?.imageSize) {
    const imageSize = options.imageSize.toUpperCase();
    if (IMAGE_SIZES.has(imageSize)) {
      imageConfig.imageSize = imageSize;
    }
  }
  if (!imageConfig.aspectRatio && !imageConfig.imageSize) {
    return undefined;
  }
  return imageConfig;
}
