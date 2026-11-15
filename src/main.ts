import type { INestApplication } from "@nestjs/common";
import { createLessfomoApp, runLessfomo } from "./bootstrap.js";
import { loadAppConfig } from "./config/app-config.js";
import { HistoryStoreUnavailableError } from "./history/infrastructure/open-history-store.js";

const config = loadAppConfig(process.env, new Date());

let app: INestApplication;
try {
  app = await createLessfomoApp(config);
} catch (error) {
  if (!(error instanceof HistoryStoreUnavailableError)) throw error;
  console.error(`[history] could not open the history store: ${error.message}`);
  process.exit(1);
}
await runLessfomo(app, config);

/** Same order as always: pipeline, API, history; then exit 0 (Nest's own signal hooks would re-raise the signal). */
const shutdown = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
