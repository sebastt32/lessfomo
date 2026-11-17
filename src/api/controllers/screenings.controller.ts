import { Controller, Get, Inject } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import type { HistoryReader } from "../../history/domain/history-reader.js";
import { HISTORY_READER } from "../../history/history.module.js";
import { LimitPipe, SearchParam } from "../http/request-params.js";
import { parseMinConvictionWallets, parseMinSmartWallets } from "../http/token-list-query.js";
import { storedScreeningView } from "../views.js";

const DEFAULT_SCREENINGS_LIMIT = 50;

@Controller("api")
export class ScreeningsController {
  constructor(
    @Inject(HISTORY_READER) private readonly history: HistoryReader,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get("screenings")
  async screenings(
    @SearchParam("limit", new LimitPipe(DEFAULT_SCREENINGS_LIMIT)) limit: number,
    @SearchParam("minSmartWallets") rawMinSmartWallets: string | null,
    @SearchParam("minConvictionWallets") rawMinConvictionWallets: string | null,
  ) {
    const minSmartWallets = parseMinSmartWallets(rawMinSmartWallets);
    const minConvictionWallets = parseMinConvictionWallets(rawMinConvictionWallets, this.config.api.publicMinConvictionWallets);
    const screenings = await this.history.recentScreenings(limit, minSmartWallets, minConvictionWallets);
    return { screenings: screenings.map(storedScreeningView) };
  }
}
