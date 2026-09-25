// Every concrete fan-out. Each is a DI singleton that FanoutManager resolves by class;
// adding a fan-out is one class and one line here.

import { GroupDayFanout } from './groupDay/GroupDayFanout';

export const FANOUT_CONTEXTS = [GroupDayFanout] as const;
