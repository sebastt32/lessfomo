import { isObject, readObject, readString, type JsonObject } from "../../../shared/json.js";
import type { MintAuthorities } from "../../domain/token-safety-snapshot.js";

/** Decides, per Token-2022 extension, whether its current state is a risk for holders. */
const DANGEROUS_EXTENSION_RULES: Record<string, (state: JsonObject | null) => boolean> = {
  permanentDelegate: (state) => state !== null && readString(state, "delegate") !== null,
  transferHook: (state) => state !== null && readString(state, "programId") !== null,
  nonTransferable: () => true,
  defaultAccountState: (state) => state !== null && state["accountState"] === "frozen",
  pausableConfig: (state) => state !== null && readString(state, "authority") !== null,
  transferFeeConfig: () => true,
  mintCloseAuthority: (state) => state !== null && readString(state, "closeAuthority") !== null,
};

const findDangerousExtensions = (info: JsonObject): string[] => {
  const extensions = info["extensions"];
  if (!Array.isArray(extensions)) return [];

  return extensions.flatMap((entry: unknown) => {
    if (!isObject(entry)) return [];
    const name = readString(entry, "extension");
    if (name === null) return [];
    const isDangerous = DANGEROUS_EXTENSION_RULES[name];
    return isDangerous?.(readObject(entry, "state")) ? [name] : [];
  });
};

/**
 * Converts the `result` of a `getAccountInfo` call (jsonParsed encoding) into MintAuthorities.
 * Returns null when the account does not exist or is not a token mint.
 */
export const parseMintAccount = (result: unknown): MintAuthorities | null => {
  if (!isObject(result)) return null;
  const account = readObject(result, "value");
  const data = account && readObject(account, "data");
  const parsed = data && readObject(data, "parsed");
  if (parsed === null || parsed["type"] !== "mint") return null;
  const info = readObject(parsed, "info");
  if (info === null) return null;

  return {
    mintAuthority: readString(info, "mintAuthority"),
    freezeAuthority: readString(info, "freezeAuthority"),
    dangerousExtensions: findDangerousExtensions(info),
  };
};
