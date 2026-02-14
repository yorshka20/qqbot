// RunPod Serverless configuration (for image-to-video via ComfyUI handler)

export interface RunpodConfig {
  /** RunPod serverless endpoint ID (e.g. xcyxkj2cn6e507) */
  endpointId: string;
  /** API key; if omitted, RUNPOD_API_KEY env is used */
  apiKey?: string;
}
