import type { MomentumSnapshot } from "../../momentum/application/momentum-tracker.js";
import type { Trade } from "../../momentum/domain/trade.js";
import type { ScreeningResult } from "../../screening/token-screener.js";
import type { NewToken } from "../../token-discovery/domain/new-token.js";

/** Port: durable record of everything observed, so the momentum hypothesis can be validated later. */
export interface HistoryRecorder {
  recordToken(token: NewToken): void;
  recordScreening(result: ScreeningResult, evaluatedAt: Date): void;
  recordTrade(trade: Trade): void;
  recordMomentum(snapshot: MomentumSnapshot): void;
}
