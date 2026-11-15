import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { API_APPLICATION_OPTIONS, createApiHttpAdapter } from "./api/http/api-http-adapter.js";
import { AppModule } from "./app.module.js";
import type { AppConfig } from "./config/app-config.js";
import { HISTORY_STORE } from "./history/history.module.js";
import type { HistoryStore } from "./history/infrastructure/open-history-store.js";
import { ScreeningPipeline } from "./screening/screening-pipeline.js";
import { errorMessage } from "./shared/error-message.js";

/** Builds every module and opens the history; rejects with `HistoryStoreUnavailableError` if it cannot. */
export const createLessfomoApp = (config: AppConfig): Promise<INestApplication> =>
  NestFactory.create(AppModule.forRoot(config), createApiHttpAdapter(), { ...API_APPLICATION_OPTIONS, abortOnError: false });

/**
 * Starts the API, then the pipeline. An API that cannot start is logged and the screener keeps
 * running without it. `app.close()` stops the pipeline, then the API, then the history.
 */
export const runLessfomo = async (app: INestApplication, config: AppConfig): Promise<void> => {
  const { host, port, corsOrigins } = config.api;
  console.log("lessfomo: screening new pump.fun tokens and tracking momentum...");
  console.log(`[history] storing in ${app.get<HistoryStore>(HISTORY_STORE).description}`);
  try {
    await app.listen(port, host);
    console.log(`[api] listening on http://${host}:${port} (CORS: ${corsOrigins.join(", ")})`);
  } catch (error) {
    console.error(`[api] could not start: ${errorMessage(error)}`);
  }
  app.get(ScreeningPipeline).start();
};
