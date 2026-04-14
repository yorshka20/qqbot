import { v4 as uuidv4 } from 'uuid';

/**
 * Random UUID v4 string (RFC 4122). Use this instead of `node:crypto` randomUUID
 * so all random IDs go through the same `uuid` dependency as v5 usage elsewhere.
 */
export function randomUUID(): string {
  return uuidv4();
}
