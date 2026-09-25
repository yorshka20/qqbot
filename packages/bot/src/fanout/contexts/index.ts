// Every concrete fan-out. FanoutInitializer registers each as a DI singleton and hands
// it to the FanoutManager; adding a fan-out is one class and one line here.

import { GroupDayFanout } from './groupDay/GroupDayFanout';

export const FANOUT_CONTEXTS = [GroupDayFanout] as const;
