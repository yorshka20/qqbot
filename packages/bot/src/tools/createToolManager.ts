// ToolManager assembly: a bare ToolManager is only a registry, so the app's instance is
// built here from the @Tool decorator metadata. The DI factory for TOOL_MANAGER calls this.
//
// Registration pattern:
//   1. Decorate executor class with @Tool({ name, description, executor, ... })
//   2. Export from src/tools/executors/index.ts (bootstrap side-effect imports that barrel,
//      which runs the decorators before this is called)
//   3. createToolManager() auto-discovers all decorated tools
//
// This is the ONLY supported registration method. Do not use filesystem scanning.

import { logger } from '@/utils/logger';
import { ToolManager } from './ToolManager';

export function createToolManager(): ToolManager {
  logger.info('📋 [ToolManager] Starting initialization...');

  const toolManager = new ToolManager();
  toolManager.autoRegisterTools();

  const tools = toolManager.getAllTools();
  logger.info(`✅ [ToolManager] Initialized with ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ')}`);
  return toolManager;
}
