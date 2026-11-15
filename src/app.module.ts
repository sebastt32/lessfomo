import { Module, type DynamicModule } from "@nestjs/common";
import { ApiModule } from "./api/api.module.js";
import type { AppConfig } from "./config/app-config.js";
import { ConfigModule } from "./config/config.module.js";
import { ScreeningModule } from "./screening/screening.module.js";

/** The whole process: the screening pipeline and the API that exposes it. */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return { module: AppModule, imports: [ConfigModule.forRoot(config), ScreeningModule, ApiModule] };
  }
}
