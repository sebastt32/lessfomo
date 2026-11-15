import { Global, Module, type DynamicModule } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "./app-config.js";

/** Makes the startup `AppConfig` injectable everywhere as `APP_CONFIG`. */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
