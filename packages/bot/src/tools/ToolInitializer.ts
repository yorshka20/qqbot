// ToolInitializer - initializes the tool system
//
// Registration pattern:
//   1. Decorate executor class with @Tool({ name, description, executor, ... })
//   2. Export from src/tools/executors/index.ts (ensures decorator runs at import time)
//   3. Call ToolInitializer.initialize() — auto-discovers all decorated tools
//
// This is the ONLY supported registration method. Do not use filesystem scanning.

// Import all tool executors to ensure decorators are executed
import '@/tools/executors';

import { logger } from '@/utils/logger';
import type { ToolManager } from './ToolManager';
import type { ToolExecutor } from './types';

export class ToolInitializer {
  /**
   * Initialize tool system.
   * Discovers all @Tool-decorated executors (imported via '@/tools/executors')
   * and registers them in the ToolManager.
   */
  static initialize(toolManager: ToolManager, executorInstances?: Map<string, ToolExecutor>): void {
    logger.info('📋 [ToolInitializer] Starting initialization...');

    toolManager.autoRegisterTools();

    if (executorInstances) {
      for (const [name, executor] of executorInstances.entries()) {
        toolManager.registerExecutor(executor);
        logger.info(`✅ [ToolInitializer] Registered executor instance: ${name}`);
      }
    }

    const tools = toolManager.getAllTools();
    logger.info(
      `✅ [ToolInitializer] Initialized with ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ')}`,
    );
  }
}
