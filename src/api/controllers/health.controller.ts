import { Controller, Get, Inject } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import type { LiveFeed } from "../../live-feed/application/live-feed.js";
import { LIVE_FEED } from "../../live-feed/live-feed.module.js";

@Controller("api")
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LIVE_FEED) private readonly feed: LiveFeed,
  ) {}

  @Get("health")
  health() {
    return { status: "ok", startedAt: this.config.startedAt.toISOString(), sources: this.feed.getSources() };
  }
}
