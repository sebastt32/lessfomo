import { isObject, readString } from "../../../shared/json.js";
import type { Trade } from "../../domain/trade.js";
import { decodePumpTradeEvent } from "./decode-pump-trade-event.js";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const INVOKE = /^Program (\w+) invoke \[\d+\]$/;
const RETURN = /^Program \w+ (success|failed)/;
const DATA_PREFIX = "Program data: ";

/**
 * Extracts pump.fun trades from one `logsNotification` value ({ signature, err, logs }).
 * Tracks the program call stack so only data emitted by pump.fun itself is decoded.
 */
export const extractPumpTrades = (value: unknown): Trade[] => {
  if (!isObject(value) || value["err"] !== null || !Array.isArray(value["logs"])) return [];
  const signature = readString(value, "signature");
  if (signature === null) return [];

  const callStack: string[] = [];
  const trades: Trade[] = [];

  for (const line of value["logs"]) {
    if (typeof line !== "string") continue;
    const invoked = INVOKE.exec(line);
    if (invoked?.[1] !== undefined) {
      callStack.push(invoked[1]);
    } else if (RETURN.test(line)) {
      callStack.pop();
    } else if (line.startsWith(DATA_PREFIX) && callStack.at(-1) === PUMP_PROGRAM_ID) {
      const trade = decodePumpTradeEvent(line.slice(DATA_PREFIX.length), signature);
      if (trade !== null) trades.push(trade);
    }
  }
  return trades;
};
