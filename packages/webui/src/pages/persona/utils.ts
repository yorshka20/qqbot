export function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

export function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString();
}
