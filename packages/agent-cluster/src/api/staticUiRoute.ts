import { serveSpaFile } from '@qqbot/shared';
import type { HubRoute } from '../cluster/hub/ContextHub';

/** The built console in `dir`, at `/`: registered last, it answers what no API route claimed. */
export function staticUiRoute(dir: string): HubRoute {
  return {
    prefix: '/',
    handle: (pathname, req) => serveSpaFile(dir, pathname, req),
  };
}
