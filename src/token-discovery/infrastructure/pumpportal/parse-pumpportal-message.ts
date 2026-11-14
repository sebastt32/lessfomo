import { isObject, readNumber, readString } from "../../../shared/json.js";
import type { NewToken } from "../../domain/new-token.js";

const safeJsonParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * Converts a raw PumpPortal `subscribeNewToken` message into a NewToken.
 * Returns null for acknowledgements, other event types, or malformed payloads.
 */
export const parsePumpPortalMessage = (raw: string, detectedAt: Date): NewToken | null => {
  const payload = safeJsonParse(raw);
  if (!isObject(payload) || payload["txType"] !== "create") return null;

  const mint = readString(payload, "mint");
  const name = readString(payload, "name");
  const symbol = readString(payload, "symbol");
  const creator = readString(payload, "traderPublicKey");
  const signature = readString(payload, "signature");
  const metadataUri = readString(payload, "uri");
  const bondingCurve = readString(payload, "bondingCurveKey");
  const pool = readString(payload, "pool");
  const initialBuyTokens = readNumber(payload, "initialBuy");
  const initialBuySol = readNumber(payload, "solAmount");
  const marketCapSol = readNumber(payload, "marketCapSol");

  if (
    mint === null ||
    name === null ||
    symbol === null ||
    creator === null ||
    signature === null ||
    metadataUri === null ||
    bondingCurve === null ||
    pool === null ||
    initialBuyTokens === null ||
    initialBuySol === null ||
    marketCapSol === null
  ) {
    return null;
  }

  return {
    mint,
    name,
    symbol,
    creator,
    signature,
    metadataUri,
    bondingCurve,
    pool,
    initialBuyTokens,
    initialBuySol,
    marketCapSol,
    detectedAt,
  };
};
