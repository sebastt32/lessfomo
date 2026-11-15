import { createHash } from "node:crypto";
import { encodeBase58 } from "../../../shared/base58.js";
import type { BondingCurveState, Trade } from "../../domain/trade.js";

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

/** real_sol_reserves(u64) and real_token_reserves(u64) follow the prefix. */
const CURVE_STATE_LENGTH = PREFIX_LENGTH + 8 + 8;

/**
 * Initial reserves of a default pump.fun curve, read from the program's Global account
 * (4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf) on mainnet. The virtual minus real reserves
 * of a curve stay constant over its life, so a curve whose difference matches these values was
 * created with them; other curves (custom depth, other configurations) report an unknown progress.
 */
const INITIAL_VIRTUAL_SOL_LAMPORTS = 30_000_000_000n;
const INITIAL_VIRTUAL_TOKEN_UNITS = 1_073_000_000_000_000n;
const INITIAL_REAL_TOKEN_UNITS = 793_100_000_000_000n;

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

/**
 * Reads the bonding curve state that a pump.fun TradeEvent carries after its stable prefix,
 * or null if the payload is not a SOL-quoted trade event long enough to hold it.
 */
export const decodePumpCurveState = (base64: string): BondingCurveState | null => {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < CURVE_STATE_LENGTH) return null;
  if (!bytes.subarray(0, 8).equals(PUMP_TRADE_EVENT_DISCRIMINATOR)) return null;

  const virtualSol = bytes.readBigUInt64LE(PREFIX_LENGTH - 16);
  const virtualTokens = bytes.readBigUInt64LE(PREFIX_LENGTH - 8);
  const realSol = bytes.readBigUInt64LE(PREFIX_LENGTH);
  const realTokens = bytes.readBigUInt64LE(PREFIX_LENGTH + 8);
  if (virtualSol === 0n || virtualTokens === 0n) return null;

  const complete = realTokens === 0n;
  const defaultCurve =
    virtualSol - realSol === INITIAL_VIRTUAL_SOL_LAMPORTS &&
    virtualTokens - realTokens === INITIAL_VIRTUAL_TOKEN_UNITS - INITIAL_REAL_TOKEN_UNITS;
  const soldPct = (Number(INITIAL_REAL_TOKEN_UNITS - realTokens) / Number(INITIAL_REAL_TOKEN_UNITS)) * 100;

  return {
    realSolReserves: Number(realSol) / LAMPORTS_PER_SOL,
    progressPct: complete ? 100 : defaultCurve ? Math.round(soldPct * 100) / 100 : null,
    complete,
  };
};
