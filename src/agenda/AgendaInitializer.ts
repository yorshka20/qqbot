// AgendaInitializer - wires up AgendaService, AgentLoop, InternalEventBus,
// ScheduleFileService (markdown → DB sync), and AgendaReporter (daily reports).

import { join } from 'node:path';
import type { LLMService } from '@/ai/services/LLMService';
import type { MessageAPI } from '@/api/methods/MessageAPI';
import type { ProtocolName } from '@/core/config/types/protocol';
import type { ConversationHistoryService } from '@/conversation/history/ConversationHistoryService';
import type { DatabaseManager } from '@/database/DatabaseManager';
import { logger } from '@/utils/logger';
import { AgendaReporter } from './AgendaReporter';
import { AgendaService } from './AgendaService';
import { AgentLoop } from './AgentLoop';
import { InternalEventBus } from './InternalEventBus';
import { ScheduleFileService } from './ScheduleFileService';

export interface AgendaComponents {
  agendaService: AgendaService;
  agentLoop: AgentLoop;
  internalEventBus: InternalEventBus;
  scheduleFileService: ScheduleFileService;
  reporter: AgendaReporter;
}

/**
 * AgendaInitializer
 *
 * Creates and wires all agenda framework components:
 *   - InternalEventBus   : typed event bus for system events
 *   - AgentLoop          : intent → LLM → sendMessage
 *   - AgendaReporter     : daily markdown report in data/agenda/reports/
 *   - AgendaService      : scheduling + CRUD + execution gate
 *   - ScheduleFileService: reads data/agenda/schedule.md → syncs items to DB
 */
export class AgendaInitializer {
  static async initialize(deps: {
    databaseManager: DatabaseManager;
    llmService: LLMService;
    messageAPI: MessageAPI;
    conversationHistoryService: ConversationHistoryService;
    preferredProtocol?: ProtocolName;
    /** Base directory for agenda data files. Defaults to `data/agenda` relative to cwd. */
    dataDir?: string;
  }): Promise<AgendaComponents> {
    logger.info('[AgendaInitializer] Initializing agenda framework...');

    const dataDir = deps.dataDir ?? join(process.cwd(), 'data', 'agenda');
    const scheduleFilePath = join(dataDir, 'schedule.md');
    const reportsDir = join(dataDir, 'reports');

    const internalEventBus = new InternalEventBus();

    const agentLoop = new AgentLoop(deps.llmService, deps.messageAPI, deps.conversationHistoryService);
    if (deps.preferredProtocol) {
      agentLoop.setPreferredProtocol(deps.preferredProtocol);
    }

    const reporter = new AgendaReporter(reportsDir);

    const agendaService = new AgendaService(
      deps.databaseManager,
      agentLoop,
      internalEventBus,
      reporter,
    );

    const scheduleFileService = new ScheduleFileService(scheduleFilePath, agendaService);

    // Ensure schedule.md exists (writes template on first run)
    await scheduleFileService.ensureFileExists();

    // Hydrate cron/once/onEvent schedules from DB
    await agendaService.start();

    // Sync schedule.md → DB (creates/updates items from the markdown file)
    await scheduleFileService.syncFromFile();

    logger.info('[AgendaInitializer] Agenda framework ready');
    return { agendaService, agentLoop, internalEventBus, scheduleFileService, reporter };
  }
}
