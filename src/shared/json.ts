export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readString = (source: JsonObject, key: string): string | null => {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

export const readNumber = (source: JsonObject, key: string): number | null => {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export const readObject = (source: JsonObject, key: string): JsonObject | null => {
  const value = source[key];
  return isObject(value) ? value : null;
};
