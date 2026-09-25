// ToolInitializer - initializes the tool system
//
// Registration pattern:
//   1. Decorate executor class with @Tool({ name, description, executor, ... })
//   2. Export from src/tools/executors/index.ts (ensures decorator runs at import time)
//   3. Call ToolInitializer.createToolManager() — auto-discovers all decorated tools
//
// This is the ONLY supported registration method. Do not use filesystem scanning.

// Import all tool executors to ensure decorators are executed
import '@/tools/executors';

import { logger } from '@/utils/logger';
import { ToolManager } from './ToolManager';

export class ToolInitializer {
  /**
   * Build the app's ToolManager: discovers all @Tool-decorated executors
   * (imported via '@/tools/executors') and registers them.
   */
  static createToolManager(): ToolManager {
    logger.info('📋 [ToolInitializer] Starting initialization...');

    const toolManager = new ToolManager();
    toolManager.autoRegisterTools();

    const tools = toolManager.getAllTools();
    logger.info(
      `✅ [ToolInitializer] Initialized with ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ')}`,
    );
    return toolManager;
  }
}
