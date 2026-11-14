import { createHash } from "node:crypto";
import { encodeBase58 } from "../../../shared/base58.js";
import type { Trade } from "../../domain/trade.js";

/** Anchor event discriminator: first 8 bytes of sha256("event:TradeEvent"). */
export const PUMP_TRADE_EVENT_DISCRIMINATOR = createHash("sha256")
  .update("event:TradeEvent")
  .digest()
  .subarray(0, 8);

const LAMPORTS_PER_SOL = 1e9;
/** Every pump.fun token uses 6 decimals. */
const TOKEN_BASE_UNITS = 1e6;

/**
 * Stable prefix of the TradeEvent layout. pump.fun appends fields over time,
 * so only this prefix is read: discriminator(8) mint(32) sol_amount(u64)
 * token_amount(u64) is_buy(u8) user(32) timestamp(i64)
 * virtual_sol_reserves(u64) virtual_token_reserves(u64).
 */
const PREFIX_LENGTH = 8 + 32 + 8 + 8 + 1 + 32 + 8 + 8 + 8;

/** Decodes a base64 `Program data:` payload into a Trade, or null if it is not a trade event. */
export const decodePumpTradeEvent = (base64: string, signature: string): Trade | null => {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < PREFIX_LENGTH) return null;
  if (!bytes.subarray(0, 8).equals(PUMP_TRADE_EVENT_DISCRIMINATOR)) return null;

  let offset = 8;
  const readPublicKey = (): string => {
    const key = encodeBase58(bytes.subarray(offset, offset + 32));
    offset += 32;
    return key;
  };
  const readU64 = (): bigint => {
    const value = bytes.readBigUInt64LE(offset);
    offset += 8;
    return value;
  };

  const mint = readPublicKey();
  const solLamports = readU64();
  const tokenUnits = readU64();
  const isBuy = bytes[offset] === 1;
  offset += 1;
  const trader = readPublicKey();
  const timestampSeconds = bytes.readBigInt64LE(offset);
  offset += 8;
  const virtualSolLamports = readU64();
  const virtualTokenUnits = readU64();

  // Curves quoted in another token (e.g. BuyExactQuoteInV2) report zero SOL reserves:
  // their amounts live in later fields, so they cannot be priced in SOL here.
  if (virtualTokenUnits === 0n || virtualSolLamports === 0n) return null;

  return {
    signature,
    mint,
    trader,
    side: isBuy ? "buy" : "sell",
    solAmount: Number(solLamports) / LAMPORTS_PER_SOL,
    tokenAmount: Number(tokenUnits) / TOKEN_BASE_UNITS,
    priceSol: Number(virtualSolLamports) / LAMPORTS_PER_SOL / (Number(virtualTokenUnits) / TOKEN_BASE_UNITS),
    timestamp: new Date(Number(timestampSeconds) * 1000),
  };
};
