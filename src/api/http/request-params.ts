import { createParamDecorator, type ExecutionContext, type PipeTransform } from "@nestjs/common";
import type { Request } from "express";
import { ApiErrors } from "./api-error.js";

const BASE58_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const MAX_LIMIT = 100;
const CANDLE_INTERVALS: Readonly<Record<string, number>> = { "1s": 1, "1m": 60, "5m": 300 };
const DEFAULT_CANDLE_INTERVAL = "1m";

/** The first value of a query parameter, or null when absent (`URLSearchParams.get`). */
export const SearchParam = createParamDecorator(
  (name: string, context: ExecutionContext): string | null =>
    new URL(context.switchToHttp().getRequest<Request>().originalUrl, "http://localhost").searchParams.get(name),
);

/** Every query parameter of the request. */
export const SearchParams = createParamDecorator(
  (_data: unknown, context: ExecutionContext): URLSearchParams =>
    new URL(context.switchToHttp().getRequest<Request>().originalUrl, "http://localhost").searchParams,
);

/** Integers are clamped to 1..max (100 unless stated); anything else falls back to the default. */
export class LimitPipe implements PipeTransform<string | null, number> {
  constructor(
    private readonly fallback: number,
    private readonly max = MAX_LIMIT,
  ) {}

  transform(raw: string | null): number {
    if (raw === null || !/^-?\d+$/.test(raw)) return this.fallback;
    return Math.min(this.max, Math.max(1, Number(raw)));
  }
}

/** A base58 mint (already percent-decoded by Express), or 400 INVALID_MINT. */
export class MintPipe implements PipeTransform<string, string> {
  transform(mint: string): string {
    if (!BASE58_MINT.test(mint)) throw ApiErrors.invalidMint();
    return mint;
  }
}

/** A base58 wallet address, or 400 INVALID_ADDRESS. */
export class AddressPipe implements PipeTransform<string, string> {
  transform(address: string): string {
    if (!BASE58_MINT.test(address)) throw ApiErrors.invalidAddress();
    return address;
  }
}

export interface CandleInterval {
  readonly name: string;
  readonly seconds: number;
}

/** `1s`, `1m` or `5m` (default `1m`), or 400 INVALID_INTERVAL. */
export const parseCandleInterval = (raw: string | null): CandleInterval => {
  const name = raw ?? DEFAULT_CANDLE_INTERVAL;
  const seconds = Object.hasOwn(CANDLE_INTERVALS, name) ? CANDLE_INTERVALS[name] : undefined;
  if (seconds === undefined) throw ApiErrors.invalidInterval();
  return { name, seconds };
};
