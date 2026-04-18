export interface DriverConfig {
  name?: string;
}

export interface VTSConfig {
  /**
   * When false, VTSDriver is not instantiated and no WS connection is
   * attempted. Compiler + preview server still run — frames are broadcast
   * to preview WS clients only (e.g., Cubism renderer consumes the same
   * stream). Default true for back-compat with the VTS-era setup.
   */
  enabled: boolean;
  host: string;
  port: number;
  pluginName: string;
  pluginDeveloper: string;
  tokenFilePath: string;
  throttleFps?: number;
}

export interface VTSRequest {
  apiName: 'VTubeStudioPublicAPI';
  apiVersion: '1.0';
  requestID: string;
  messageType: string;
  data: Record<string, unknown>;
}

export interface VTSResponse {
  apiName: 'VTubeStudioPublicAPI';
  apiVersion: '1.0';
  timestamp: number;
  requestID: string;
  messageType: string;
  data: Record<string, unknown>;
}

export interface VTSParameterValue {
  id: string;
  value: number;
  weight?: number;
}

export const DEFAULT_VTS_CONFIG: VTSConfig = {
  enabled: true,
  host: 'localhost',
  port: 8001,
  pluginName: 'qqbot-avatar',
  pluginDeveloper: 'qqbot',
  tokenFilePath: 'data/avatar/.vts-token',
  throttleFps: 30,
};
