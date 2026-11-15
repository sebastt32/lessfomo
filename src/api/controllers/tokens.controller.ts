import { Controller, Get, Inject, Param, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { HistoryReader } from "../../history/domain/history-reader.js";
import type { TokenCatalogReader } from "../../history/domain/token-catalog-reader.js";
import { HISTORY_READER, TOKEN_CATALOG_READER } from "../../history/history.module.js";
import type { SolUsdPrice } from "../../market-price/domain/sol-usd-price.js";
import { SOL_USD_PRICE } from "../../market-price/market-price.module.js";
import { ApiErrors } from "../http/api-error.js";
import { LimitPipe, MintPipe, parseCandleInterval, SearchParam, SearchParams } from "../http/request-params.js";
import { parseTokenListQuery } from "../http/token-list-query.js";
import { LiveStreams } from "../live-streams.js";
import { candleView, devTradeView, tokenHistoryView, tokenListItemView, tokenSnapshotsView } from "../views.js";

const DEFAULT_CANDLES_LIMIT = 300;
const MAX_CANDLES_LIMIT = 1000;
/** pump.fun tokens always have a fixed supply of one billion. */
const PUMP_TOTAL_SUPPLY = 1_000_000_000;

/** Routes are matched in declaration order: the catch-all must stay last. */
@Controller("api")
export class TokensController {
  constructor(
    @Inject(HISTORY_READER) private readonly history: HistoryReader,
    @Inject(TOKEN_CATALOG_READER) private readonly catalog: TokenCatalogReader,
    @Inject(SOL_USD_PRICE) private readonly solPrice: SolUsdPrice,
    @Inject(LiveStreams) private readonly streams: LiveStreams,
  ) {}

  @Get("tokens")
  async list(@SearchParams() params: URLSearchParams) {
    const query = parseTokenListQuery(params, new Date());
    const { tokens, total } = await this.catalog.listTokens(query);
    return { tokens: tokens.map(tokenListItemView), page: query.page, pageSize: query.pageSize, total };
  }

  @Get("tokens/:mint/snapshots")
  async snapshots(@Param("mint", MintPipe) mint: string) {
    const snapshots = await this.catalog.tokenSnapshots(mint, new Date());
    if (snapshots === null) throw ApiErrors.tokenNotFound();
    return tokenSnapshotsView(mint, snapshots);
  }

  @Get("tokens/:mint/candles")
  async candles(
    @Param("mint", MintPipe) mint: string,
    @SearchParam("interval") rawInterval: string | null,
    @SearchParam("limit", new LimitPipe(DEFAULT_CANDLES_LIMIT, MAX_CANDLES_LIMIT)) limit: number,
  ) {
    const interval = parseCandleInterval(rawInterval);
    const chart = await this.history.tokenChart(mint, interval.seconds, limit);
    if (chart === null) throw ApiErrors.tokenNotFound();
    return {
      mint,
      interval: interval.name,
      totalSupply: PUMP_TOTAL_SUPPLY,
      solUsd: this.solPrice.current(),
      candles: chart.candles.map(candleView),
      devTrades: chart.devTrades.map(devTradeView),
    };
  }

  @Get("tokens/:mint/stream")
  stream(@Param("mint", MintPipe) mint: string, @Req() request: Request, @Res() response: Response): void {
    this.streams.openToken(request, response, mint);
  }

  @Get("tokens/:mint")
  async token(@Param("mint", MintPipe) mint: string) {
    const tokenHistory = await this.history.tokenHistory(mint);
    if (tokenHistory === null) throw ApiErrors.tokenNotFound();
    return tokenHistoryView(tokenHistory);
  }

  /** Anything else under a token (`/api/tokens/`, `/api/tokens/<mint>/other`) is not a mint. */
  @Get("tokens/{*rest}")
  notAMint(): never {
    throw ApiErrors.invalidMint();
  }
}
