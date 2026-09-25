// Every concrete fan-out. Each is a DI singleton that FanoutInitializer exposes to the
// FanoutManager; adding a fan-out is one class and one line here.

import { GroupDayFanout } from './groupDay/GroupDayFanout';

export const FANOUT_CONTEXTS = [GroupDayFanout] as const;
