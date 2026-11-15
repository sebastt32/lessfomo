import { BadRequestException, Catch, Inject, NotFoundException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { ApiError, ApiErrors } from "./api-error.js";

/** Injection token of the function told about every unexpected error (never sent to clients). */
export const API_ERROR_REPORTER = Symbol("API_ERROR_REPORTER");
export type ApiErrorReporter = (error: unknown) => void;

/** Known failures keep their documented code; anything else is reported and answered as a generic 500. */
const toApiError = (exception: unknown): ApiError | null => {
  if (exception instanceof ApiError) return exception;
  // Nest's handler for requests that match no route.
  if (exception instanceof NotFoundException) return ApiErrors.routeNotFound();
  // Express could not percent-decode a route parameter; every route parameter is a mint.
  if (exception instanceof BadRequestException && exception.cause instanceof URIError) return ApiErrors.invalidMint();
  return null;
};

/** Maps every error to the error shape of docs/API.md. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(@Inject(API_ERROR_REPORTER) private readonly report: ApiErrorReporter) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    let error = toApiError(exception);
    if (error === null) {
      this.report(exception);
      if (response.headersSent) {
        response.end();
        return;
      }
      error = ApiErrors.internal();
    }
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
  }
}
