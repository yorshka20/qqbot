# 本地视频分析流水线方案 (Bun + TypeScript)

## 1. 核心架构
本方案采用 Bun 作为运行时，通过子进程调用系统工具链，实现视频处理与模型分析的自动化流水线。

## 2. 工具链依赖
- **yt-dlp**: 下载视频流。
- **ffmpeg**: 视频转图片序列（抽帧）。
- **Google Generative AI SDK (Node/Bun)**: 调用 Gemini 2.0 Flash。

## 3. 实现流水线 (TypeScript)

```typescript
import { GoogleGenerativeAI } from "@google/generative-ai";
import { $ } from "bun";
import { unlink } from "node:fs/promises";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

async function analyzeVideo(url: string, prompt: string) {
  // 1. 下载视频 (使用 yt-dlp)
  await $`yt-dlp -o video.mp4 ${url}`;

  // 2. 抽帧 (每秒 1 帧)
  await $`mkdir -p frames && ffmpeg -i video.mp4 -vf fps=1 frames/frame_%04d.jpg -y`;

  // 3. 上传并分析
  const frames = await Array.fromAsync(new Bun.Glob("frames/*.jpg").scan());
  const uploadedFiles = [];

  try {
    for (const framePath of frames) {
      const file = await genAI.getFileManager().uploadFile(framePath, { mimeType: "image/jpeg" });
      uploadedFiles.push(file);
    }

    const response = await model.generateContent([prompt, ...uploadedFiles]);
    return response.text();
  } finally {
    // 4. 清理资源 (本地文件 + 云端资源)
    await $`rm -rf frames video.mp4`;
    for (const file of uploadedFiles) {
      await genAI.getFileManager().deleteFile(file.name);
    }
  }
}
```

## 4. 成本优化建议
- **抽帧频率**: 根据视频内容动态调整，讲解类视频建议 0.5fps。
- **并发控制**: 上传文件时使用 Promise.all 限制并发，避免触发 API 频率限制。
- **错误处理**: 务必在 `finally` 中清理已上传的云端资源，防止产生不必要的存储占用。
