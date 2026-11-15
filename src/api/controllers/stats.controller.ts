import { Controller, Get, Inject } from "@nestjs/common";
import type { TokenCatalogReader } from "../../history/domain/token-catalog-reader.js";
import { TOKEN_CATALOG_READER } from "../../history/history.module.js";
import { statsView } from "../views.js";

@Controller("api")
export class StatsController {
  constructor(@Inject(TOKEN_CATALOG_READER) private readonly catalog: TokenCatalogReader) {}

  @Get("stats")
  async stats() {
    return statsView(await this.catalog.stats(new Date()));
  }
}
