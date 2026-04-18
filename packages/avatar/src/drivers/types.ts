export interface DriverConfig {
  name?: string;
}

export interface VTSConfig {
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
  host: 'localhost',
  port: 8001,
  pluginName: 'qqbot-avatar',
  pluginDeveloper: 'qqbot',
  tokenFilePath: 'config/avatar/.vts-token',
  throttleFps: 30,
};
