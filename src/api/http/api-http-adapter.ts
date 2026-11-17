import type { RequestListener, Server } from "node:http";
import type { NestApplicationOptions } from "@nestjs/common";
import { ExpressAdapter } from "@nestjs/platform-express";
import express from "express";
import { normalizeRequestTarget } from "./request-target.js";

/** Options of every Nest application serving the API, in production and in tests. */
export const API_APPLICATION_OPTIONS = {
  /** The process prints its own console lines; errors go through `API_ERROR_REPORTER`. */
  logger: false,
  /** Closing the API also drops idle keep-alive connections, so shutdown never waits for clients. */
  forceCloseConnections: true,
  /** No global body parser: only `/api/auth/*` reads a (small, JSON) body, with its own reader. */
  bodyParser: false,
} as const satisfies NestApplicationOptions;

/**
 * Express exactly as the API routes: paths are case sensitive and a trailing slash is a different
 * path, no `X-Powered-By` or `ETag`, and every request target is normalized before Express sees it.
 */
class ApiHttpAdapter extends ExpressAdapter {
  override initHttpServer(options: NestApplicationOptions): void {
    super.initHttpServer(options);
    const server: Server = this.getHttpServer();
    const listeners = server.listeners("request") as RequestListener[];
    server.removeAllListeners("request");
    server.on("request", (request, response) => {
      normalizeRequestTarget(request);
      for (const listener of listeners) listener(request, response);
    });
  }
}

export const createApiHttpAdapter = (): ExpressAdapter => {
  const app = express();
  app.enable("case sensitive routing");
  app.enable("strict routing");
  app.disable("x-powered-by");
  app.set("etag", false);
  return new ApiHttpAdapter(app);
};
