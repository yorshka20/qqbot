export interface AvatarSynthesisChunk {
  bytes: Uint8Array;
  mime: string;
  sampleRate?: number;
  isLast: boolean;
  totalDurationMs?: number;
}

export interface AvatarSynthesisResult {
  bytes: Uint8Array;
  mime: string;
  durationMs: number;
  sampleRate?: number;
}

export interface AvatarTTSProvider {
  readonly name: string;
  isAvailable(): boolean;
  synthesize(text: string, opts?: { voice?: string }): Promise<AvatarSynthesisResult>;
  synthesizeStream?(text: string, opts?: { voice?: string }): AsyncIterable<AvatarSynthesisChunk>;
}

export interface AvatarTTSManager {
  getDefault(): AvatarTTSProvider | null;
}
