import type { Pool } from "pg";
import { createPublicClient, defineChain, hexToString, http } from "viem";

export const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

export function normalizeTokenAddress(addr: string): string {
  return addr.toLowerCase();
}

/**
 * True when DB symbol is missing or is the indexer’s address-prefix placeholder
 * (or a short 0x-hex fragment of the address), so we should read ERC20 metadata on-chain.
 */
export function needsOnChainTokenMetadata(symbol: string | null | undefined, address: string): boolean {
  const a = normalizeTokenAddress(address);
  if (a === NATIVE_TOKEN_ADDRESS) return false;
  const s = (symbol ?? "").trim();
  if (!s) return true;
  const sl = s.toLowerCase();
  if (sl === a.slice(0, 6)) return true;
  if (/^0x[0-9a-f]+$/i.test(s) && a.startsWith(sl) && s.length <= 12) return true;
  return false;
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
  return stripNullBytes(hexToString(raw as `0x${string}`, { size: 32 }));
}

async function readSymbol(client: ReturnType<typeof createPublicClient>, addr: `0x${string}`): Promise<string> {
  try {
    return await readSymbolString(client, addr);
  } catch {
    return await readSymbolBytes32(client, addr);
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

export function createMonadPublicClient(rpcUrl: string, chainId: number) {
  const chain = defineChain({
    id: chainId,
    name: "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  return createPublicClient({ chain, transport: http(rpcUrl) });
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
  try {
    const [symbol, decimals, name] = await Promise.all([
      readSymbol(client, addr),
      client
        .readContract({ address: addr, abi: erc20DecimalsAbi, functionName: "decimals" })
        .then((d) => Number(d))
        .catch(() => 18),
      readName(client, addr).catch(() => undefined),
    ]);
    if (!symbol) return null;
    const dec = Number.isFinite(decimals) && decimals >= 0 ? decimals : 18;
    return { address: a, symbol, name, decimals: dec };
  } catch {
    return null;
  }
}

/** Resolve many addresses with bounded concurrency (RPC-friendly). */
export async function resolveTokenMetadataMap(
  addresses: string[],
  rpcUrl: string | undefined,
  chainId: number,
  concurrency = 6,
): Promise<Map<string, ResolvedTokenMeta>> {
  const out = new Map<string, ResolvedTokenMeta>();
  if (!rpcUrl?.trim() || addresses.length === 0) return out;

  const client = createMonadPublicClient(rpcUrl.trim(), chainId);
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

export function getMonadRpcConfig(): { rpcUrl: string | undefined; chainId: number } {
  const rpcUrl = process.env.MONAD_RPC_URL?.trim();
  const chainId = Number(process.env.MONAD_CHAIN_ID ?? "143");
  return { rpcUrl: rpcUrl || undefined, chainId: Number.isFinite(chainId) && chainId > 0 ? chainId : 143 };
}
