/**
 * viem's `http()` transport uses `fetch`, which does not support `ws:` / `wss:`.
 * Many providers expose the same host over HTTPS; map WebSocket URLs to HTTP(S).
 */
export function normalizeEvmRpcHttpUrl(url: string): string {
  const t = url.trim();
  if (t.startsWith("wss://")) return `https://${t.slice(6)}`;
  if (t.startsWith("ws://")) return `http://${t.slice(5)}`;
  return t;
}
