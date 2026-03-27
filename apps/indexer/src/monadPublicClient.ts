import { normalizeEvmRpcHttpUrl } from "@monmon/shared";
import { createPublicClient, defineChain, http, webSocket, type PublicClient } from "viem";
import type { Env } from "./config.js";

/**
 * viem `http()` uses fetch (no WebSocket). Providers that only expose `wss://` need `webSocket()`.
 */
export function createMonadPublicClient(env: Env): PublicClient {
  const rpc = env.MONAD_RPC_URL.trim();
  const monadChain = defineChain({
    id: env.MONAD_CHAIN_ID,
    name: "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: {
      default: {
        http: [rpc.startsWith("http") ? rpc : normalizeEvmRpcHttpUrl(rpc)],
      },
    },
  });

  const transport =
    rpc.startsWith("wss://") || rpc.startsWith("ws://") ? webSocket(rpc) : http(normalizeEvmRpcHttpUrl(rpc));

  return createPublicClient({
    chain: monadChain,
    transport,
  });
}
