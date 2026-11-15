import { Controller, Get, Inject } from "@nestjs/common";
import type { LiveFeed } from "../../live-feed/application/live-feed.js";
import { LIVE_FEED } from "../../live-feed/live-feed.module.js";
import { LimitPipe, SearchParam } from "../http/request-params.js";
import { moverView } from "../views.js";

const DEFAULT_MOVERS_LIMIT = 20;

@Controller("api")
export class MoversController {
  constructor(@Inject(LIVE_FEED) private readonly feed: LiveFeed) {}

  @Get("movers")
  movers(@SearchParam("limit", new LimitPipe(DEFAULT_MOVERS_LIMIT)) limit: number) {
    const { at, movers } = this.feed.getMovers(limit);
    return { at: at?.toISOString() ?? null, movers: movers.map(moverView) };
  }
}
