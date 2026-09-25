import type { Config } from '@/core/config';
import type { FileReadServiceConfig } from '@/core/config/types/bot';
import { FileReadService } from '../FileReadService';

export function createFileReadService(config?: FileReadServiceConfig): FileReadService {
  return new FileReadService({ getFileReadServiceConfig: () => config } as unknown as Config);
}
