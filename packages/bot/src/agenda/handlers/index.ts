// Framework-level action handlers: each backed by a core service, alive for the whole
// process. AgendaInitializer resolves every class here from DI and registers it; adding
// one is a class and a line. Plugin-owned handlers are not listed — they follow their
// plugin's enable state through AgendaService.registerActionHandler.

import { ClusterTicketsSyncHandler } from './ClusterTicketsGitHandlers';
import { FanoutActionHandler } from './FanoutActionHandler';
import { RepeatingTicketDispatchHandler } from './RepeatingTicketDispatchHandler';
import { RepeatingTodoWorkerHandler } from './RepeatingTodoWorkerHandler';
import { TodoWorkerHandler } from './TodoWorkerHandler';

export const AGENDA_ACTION_HANDLERS = [
  ClusterTicketsSyncHandler,
  FanoutActionHandler,
  RepeatingTicketDispatchHandler,
  RepeatingTodoWorkerHandler,
  TodoWorkerHandler,
] as const;
