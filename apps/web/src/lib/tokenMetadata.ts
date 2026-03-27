import { normalizeEvmRpcHttpUrl } from "@monmon/shared";
import type { Pool } from "pg";
import { createPublicClient, defineChain, hexToString, http, webSocket, type PublicClient } from "viem";

export const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

export function normalizeTokenAddress(addr: string): string {
  return addr.toLowerCase();
}

/** DB / indexer placeholder: hex-y “symbol” that is not a real ticker. */
export function looksLikeHexPlaceholderSymbol(symbol: string, address: string): boolean {
  const a = normalizeTokenAddress(address);
  const s = symbol.trim();
  if (!s) return true;
  const sl = s.toLowerCase();
  if (sl === a) return true;
  if (sl.length <= 12 && a.startsWith(sl)) return true;
  if (sl.length <= 12 && sl === a.slice(0, sl.length)) return true;
  if (/^0x[0-9a-f]+$/i.test(s) && s.length >= 4 && s.length < 42) return true;
  return false;
}

/**
 * True when we should hit RPC: missing symbol or obvious address/hex placeholder.
 */
export function needsOnChainTokenMetadata(symbol: string | null | undefined, address: string): boolean {
  const a = normalizeTokenAddress(address);
  if (a === NATIVE_TOKEN_ADDRESS) return false;
  return looksLikeHexPlaceholderSymbol(symbol ?? "", address);
}

const erc20SymbolStringAbi = [
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

const erc20SymbolBytesAbi = [
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const erc20NameStringAbi = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

const erc20NameBytesAbi = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const erc20DecimalsAbi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

function stripNullBytes(s: string): string {
  return s.replace(/\0/g, "").trim();
}

async function readSymbolString(client: ReturnType<typeof createPublicClient>, addr: `0x${string}`): Promise<string> {
  const v = await client.readContract({
    address: addr,
    abi: erc20SymbolStringAbi,
    functionName: "symbol",
  });
  return String(v).trim();
}

async function readSymbolBytes32(client: ReturnType<typeof createPublicClient>, addr: `0x${string}`): Promise<string> {
  const raw = await client.readContract({
    address: addr,
    abi: erc20SymbolBytesAbi,
    functionName: "symbol",
  });
  try {
    return stripNullBytes(hexToString(raw as `0x${string}`, { size: 32 }));
  } catch {
    return "";
  }
}

async function readSymbol(client: ReturnType<typeof createPublicClient>, addr: `0x${string}`): Promise<string> {
  try {
    const s = await readSymbolString(client, addr);
    if (s) return s;
  } catch {
    /* try bytes32 */
  }
  try {
    return await readSymbolBytes32(client, addr);
  } catch {
    return "";
  }
}

async function readName(client: ReturnType<typeof createPublicClient>, addr: `0x${string}`): Promise<string | undefined> {
  try {
    const v = await client.readContract({
      address: addr,
      abi: erc20NameStringAbi,
      functionName: "name",
    });
    return String(v).trim() || undefined;
  } catch {
    try {
      const raw = await client.readContract({
        address: addr,
        abi: erc20NameBytesAbi,
        functionName: "name",
      });
      const s = stripNullBytes(hexToString(raw as `0x${string}`, { size: 32 }));
      return s || undefined;
    } catch {
      return undefined;
    }
  }
}

export type ResolvedTokenMeta = {
  address: string;
  symbol: string;
  name?: string;
  decimals: number;
};

export function createMonadPublicClient(rpcUrl: string, chainId: number): PublicClient {
  const r = rpcUrl.trim();
  const chain = defineChain({
    id: chainId,
    name: "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: {
      default: {
        http: [r.startsWith("http") ? r : normalizeEvmRpcHttpUrl(r)],
      },
    },
  });
  const transport =
    r.startsWith("wss://") || r.startsWith("ws://") ? webSocket(r) : http(normalizeEvmRpcHttpUrl(r));
  return createPublicClient({ chain, transport });
}

function shortenDisplayLabel(s: string, max = 24): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export async function readErc20Metadata(
  client: ReturnType<typeof createPublicClient>,
  address: string,
): Promise<ResolvedTokenMeta | null> {
  const a = normalizeTokenAddress(address);
  if (a === NATIVE_TOKEN_ADDRESS) {
    return { address: a, symbol: "MON", name: "MON", decimals: 18 };
  }
  const addr = a as `0x${string}`;

  let decimals = 18;
  try {
    const d = await client.readContract({ address: addr, abi: erc20DecimalsAbi, functionName: "decimals" });
    const n = Number(d);
    if (Number.isFinite(n) && n >= 0 && n <= 255) decimals = n;
  } catch {
    /* default */
  }

  const rawSymbol = (await readSymbol(client, addr).catch(() => "")).trim();
  const name = (await readName(client, addr).catch(() => undefined))?.trim();

  let symbol = rawSymbol;
  if (!symbol || looksLikeHexPlaceholderSymbol(symbol, a)) {
    symbol = "";
  }

  if (!symbol && name) {
    symbol = shortenDisplayLabel(name, 28);
  }

  if (!symbol) return null;

  const dec = decimals;
  return {
    address: a,
    symbol,
    name: name && name !== symbol ? name : undefined,
    decimals: dec,
  };
}

/** Resolve many addresses with bounded concurrency (RPC-friendly). */
export async function resolveTokenMetadataMap(
  addresses: string[],
  rpcUrl: string | undefined,
  chainId: number,
  concurrency = 6,
): Promise<Map<string, ResolvedTokenMeta>> {
  const out = new Map<string, ResolvedTokenMeta>();
  const url = rpcUrl?.trim();
  if (!url || addresses.length === 0) return out;

  const client = createMonadPublicClient(url, chainId);
  const uniq = [...new Set(addresses.map(normalizeTokenAddress))];

  for (let i = 0; i < uniq.length; i += concurrency) {
    const chunk = uniq.slice(i, i + concurrency);
    const settled = await Promise.all(
      chunk.map(async (addr) => {
        const meta = await readErc20Metadata(client, addr);
        return meta ? ([meta.address, meta] as const) : null;
      }),
    );
    for (const row of settled) {
      if (row) out.set(row[0], row[1]);
    }
  }
  return out;
}

/** Upsert resolved metadata so the indexer and future API calls get real symbols. */
export async function persistTokenMetadataToDb(db: Pool, meta: ResolvedTokenMeta): Promise<void> {
  const name = meta.name && meta.name.length > 0 ? meta.name : meta.symbol;
  await db.query(
    `INSERT INTO tokens (token_address, symbol, name, decimals)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token_address)
     DO UPDATE SET
       symbol = EXCLUDED.symbol,
       name = COALESCE(NULLIF(EXCLUDED.name, ''), tokens.name),
       decimals = EXCLUDED.decimals`,
    [meta.address, meta.symbol, name, meta.decimals],
  );
}

/**
 * Prefer private MONAD_RPC_URL in production; fall back to NEXT_PUBLIC_* or the public Monad RPC
 * so token metadata resolution still works when only DATABASE_URL was copied to Vercel.
 */
export function getMonadRpcConfig(): { rpcUrl: string; chainId: number } {
  const rpcUrl =
    process.env.MONAD_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_MONAD_RPC_URL?.trim() ||
    "https://rpc.monad.xyz";
  const chainId = Number(process.env.MONAD_CHAIN_ID ?? process.env.NEXT_PUBLIC_MONAD_CHAIN_ID ?? "143");
  return { rpcUrl, chainId: Number.isFinite(chainId) && chainId > 0 ? chainId : 143 };
}
