import { useSyncExternalStore } from 'react';

const TOKEN_KEY = 'cluster-ui.token';

export interface Session {
  token: string | null;
  /** The stored token was refused by the daemon, so the gate explains why it is back. */
  rejected: boolean;
}

let session: Session = { token: localStorage.getItem(TOKEN_KEY), rejected: false };
const listeners = new Set<() => void>();

function setSession(next: Session): void {
  session = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSession(): Session {
  return useSyncExternalStore(subscribe, () => session);
}

export function signIn(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  setSession({ token, rejected: false });
}

export function signOut(rejected = false): void {
  localStorage.removeItem(TOKEN_KEY);
  setSession({ token: null, rejected });
}

function withBearer(token: string, init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/** `fetch` carrying the session token. A 401 ends the session, which sends the UI back to the token gate. */
export async function authorizedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = session.token;
  const res = await fetch(path, withBearer(token ?? '', init));
  // A slow request can land after the user already entered a new token.
  if (res.status === 401 && session.token === token) {
    signOut(true);
  }
  return res;
}

export type TokenCheck = 'ok' | 'rejected' | 'unreachable';

export async function checkToken(token: string): Promise<TokenCheck> {
  try {
    const res = await fetch('/health', withBearer(token));
    if (res.status === 401) {
      return 'rejected';
    }
    return res.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}
