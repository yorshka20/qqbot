// URL safety guards: identify URLs that must not be sent to third-party
// fetch services (e.g. Jina Reader) because they target private networks
// or local machines. Sending these would both fail and leak topology.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function isPrivateIPv4(host: string): boolean {
  // Strict IPv4 dotted-quad check; bail otherwise.
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 127) return true; // loopback range
  return false;
}

/**
 * Returns true when the URL points to a private network, loopback, link-local,
 * or *.local mDNS host. Such URLs should be fetched locally only, never proxied
 * through a third-party reader API.
 */
export function isInternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'file:') return true;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host.endsWith('.local')) return true;
  if (host.endsWith('.internal')) return true;
  return isPrivateIPv4(host);
}
