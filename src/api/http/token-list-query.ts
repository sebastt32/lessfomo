import type {
  Lifecycle,
  SafetyStatus,
  TokenListQuery,
  TokenSortField,
} from "../../history/domain/token-catalog-reader.js";
import { ApiErrors } from "./api-error.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_SEARCH_LENGTH = 100;
const STATUSES: readonly SafetyStatus[] = ["passed", "failed", "unverified", "pending"];
const LIFECYCLES: readonly Lifecycle[] = ["active", "dead"];
const SORT_FIELDS: readonly TokenSortField[] = ["detectedAt", "maxScore", "peakMarketCapSol", "liquidity"];
/** A date (UTC midnight) or a date-time with an explicit offset. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const INTEGER = /^\d+$/;

const isOneOf = <T extends string>(values: readonly T[], value: string): value is T =>
  (values as readonly string[]).includes(value);

const parseInstant = (name: string, raw: string | null): Date | null => {
  if (raw === null) return null;
  const match = ISO_DATE.exec(raw);
  const date = match === null ? null : new Date(match[4] === undefined ? `${raw}T00:00:00.000Z` : raw);
  const valid = date !== null && !Number.isNaN(date.getTime());
  // Rejects calendar overflow such as 2026-02-30, which Date would roll into March.
  const sameDay =
    valid && (match?.[4] !== undefined || date.toISOString().startsWith(`${match?.[1]}-${match?.[2]}-${match?.[3]}`));
  if (date === null || !valid || !sameDay) {
    throw ApiErrors.invalidQuery(name, "an ISO 8601 date or date-time");
  }
  return date;
};

const parseStatuses = (raw: string | null): SafetyStatus[] => {
  if (raw === null) return [];
  const statuses = raw.split(",");
  if (!statuses.every((status) => isOneOf(STATUSES, status))) {
    throw ApiErrors.invalidQuery("status", `a comma-separated list of ${STATUSES.join(", ")}`);
  }
  return [...new Set(statuses)];
};

const parseLifecycle = (raw: string | null): Lifecycle | null => {
  if (raw === null) return null;
  if (!isOneOf(LIFECYCLES, raw)) throw ApiErrors.invalidQuery("lifecycle", LIFECYCLES.join(" or "));
  return raw;
};

const parseMinScore = (raw: string | null): number | null => {
  if (raw === null) return null;
  const score = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw ApiErrors.invalidQuery("minScore", "a number from 0 to 100");
  return score;
};

const parseSearch = (raw: string | null): string | null => {
  const search = raw?.trim() ?? "";
  if (search.length > MAX_SEARCH_LENGTH) throw ApiErrors.invalidQuery("q", `at most ${MAX_SEARCH_LENGTH} characters`);
  return search === "" ? null : search;
};

const parseSort = (raw: string | null): TokenListQuery["sort"] => {
  if (raw === null) return { field: "detectedAt", direction: "desc" };
  const [field = "", direction = "desc", ...rest] = raw.split(":");
  if (!isOneOf(SORT_FIELDS, field) || (direction !== "asc" && direction !== "desc") || rest.length > 0) {
    throw ApiErrors.invalidQuery("sort", `one of ${SORT_FIELDS.join(", ")} with :asc or :desc`);
  }
  return { field, direction };
};

const parsePositiveInteger = (name: string, raw: string | null, fallback: number): number => {
  if (raw === null) return fallback;
  if (!INTEGER.test(raw)) throw ApiErrors.invalidQuery(name, "a positive integer");
  return Number(raw);
};

/** Reads `GET /api/tokens` parameters (first value of each), or throws 400 INVALID_QUERY naming the bad one. */
export const parseTokenListQuery = (params: URLSearchParams, now: Date): TokenListQuery => {
  const page = parsePositiveInteger("page", params.get("page"), 1);
  if (page < 1) throw ApiErrors.invalidQuery("page", "a positive integer");
  const pageSize = parsePositiveInteger("pageSize", params.get("pageSize"), DEFAULT_PAGE_SIZE);
  return {
    from: parseInstant("from", params.get("from")),
    to: parseInstant("to", params.get("to")),
    statuses: parseStatuses(params.get("status")),
    lifecycle: parseLifecycle(params.get("lifecycle")),
    minScore: parseMinScore(params.get("minScore")),
    search: parseSearch(params.get("q")),
    sort: parseSort(params.get("sort")),
    page,
    pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize)),
    now,
  };
};
