import { isObject, readNumber, readObject, readString, type JsonObject } from "../../../shared/json.js";
import type { HolderDistribution, TokenHolder } from "../../domain/token-safety-snapshot.js";

/** Account types that hold supply on behalf of the market, not of a person. */
const NON_WALLET_ACCOUNT_TYPES = new Set(["AMM", "LOCKER"]);

const findNonWalletAccounts = (report: JsonObject, bondingCurve: string): Set<string> => {
  const excluded = new Set([bondingCurve]);
  const known = readObject(report, "knownAccounts");
  if (known === null) return excluded;

  for (const [address, entry] of Object.entries(known)) {
    if (isObject(entry) && NON_WALLET_ACCOUNT_TYPES.has(String(entry["type"]))) {
      excluded.add(address);
    }
  }
  return excluded;
};

const parseHolder = (entry: unknown): (TokenHolder & { address: string | null }) | null => {
  if (!isObject(entry)) return null;
  const owner = readString(entry, "owner");
  const pct = readNumber(entry, "pct");
  if (owner === null || pct === null) return null;
  return { owner, pct, insider: entry["insider"] === true, address: readString(entry, "address") };
};

/**
 * Converts a RugCheck `/v1/tokens/{mint}/report` payload into a HolderDistribution.
 * The bonding curve, pools and lockers are excluded so only real wallets count.
 * Returns null when the report lacks the supply or the holder list.
 */
export const parseRugCheckReport = (payload: unknown, bondingCurve: string): HolderDistribution | null => {
  if (!isObject(payload)) return null;
  const token = readObject(payload, "token");
  const supply = token && readNumber(token, "supply");
  const topHolders = payload["topHolders"];
  if (supply === null || supply <= 0 || !Array.isArray(topHolders)) return null;

  const excluded = findNonWalletAccounts(payload, bondingCurve);
  const holders = topHolders
    .map(parseHolder)
    .filter((holder) => holder !== null)
    .filter((holder) => !excluded.has(holder.owner) && (holder.address === null || !excluded.has(holder.address)))
    .map(({ owner, pct, insider }) => ({ owner, pct, insider }));

  const creatorBalance = readNumber(payload, "creatorBalance") ?? 0;

  return {
    holders,
    creatorPct: (creatorBalance / supply) * 100,
    insiderNetworks: readNumber(payload, "graphInsidersDetected") ?? 0,
    totalHolders: readNumber(payload, "totalHolders") ?? holders.length,
  };
};
