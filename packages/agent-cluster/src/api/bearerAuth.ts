import { timingSafeEqual } from 'node:crypto';
import type { HubRoute } from '../cluster/hub/ContextHub';
import { errorResponse } from './http';

/** Wrap a route so every request under its prefix must carry `Authorization: Bearer <token>`. */
export function withBearerToken(token: string, route: HubRoute): HubRoute {
  return {
    prefix: route.prefix,
    handle(pathname, req) {
      if (!hasBearerToken(req, token)) {
        return errorResponse('Unauthorized', 401);
      }
      return route.handle(pathname, req);
    },
  };
}

export function hasBearerToken(req: Request, token: string): boolean {
  const header = req.headers.get('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return false;
  }
  const presented = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
