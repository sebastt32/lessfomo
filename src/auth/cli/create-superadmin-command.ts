import { loadAppConfig, type Environment } from "../../config/app-config.js";
import { openHistoryStore, type HistoryStore } from "../../history/infrastructure/open-history-store.js";
import { errorMessage } from "../../shared/error-message.js";
import { provisionSuperadmin } from "../application/superadmin.js";
import { isValidUsername } from "../domain/user.js";

export interface CommandOutput {
  out(line: string): void;
  err(line: string): void;
}

const DEFAULT_USERNAME = "superadmin";
const USAGE = [
  "Usage: node dist/create-superadmin.js [username] [--reset]",
  "  username  1 to 64 letters, digits, dots, dashes or underscores (default: superadmin)",
  "  --reset   set a new password for an existing user and sign it out everywhere",
].join("\n");

const parseArgs = (args: readonly string[]): { username: string; reset: boolean } | null => {
  const options = args.filter((arg) => arg.startsWith("-"));
  const names = args.filter((arg) => !arg.startsWith("-"));
  if (options.some((option) => option !== "--reset") || options.length > 1 || names.length > 1) return null;
  const username = names[0] ?? DEFAULT_USERNAME;
  return isValidUsername(username) ? { username, reset: options.length === 1 } : null;
};

/**
 * `create-superadmin [username] [--reset]` (decision D4): creates the super admin in the same
 * history store the app uses (`DATABASE_URL`, otherwise the SQLite file) and prints its random
 * password once. Only opens that store: no screener, no HTTP server, no network source.
 * Returns the process exit code: 0 done, 1 refused or failed, 2 wrong usage.
 */
export const runCreateSuperadmin = async (args: readonly string[], env: Environment, output: CommandOutput): Promise<number> => {
  const parsed = parseArgs(args);
  if (parsed === null) {
    output.err(USAGE);
    return 2;
  }
  const now = new Date();
  let store: HistoryStore;
  try {
    store = await openHistoryStore(loadAppConfig(env, now).history);
  } catch (error) {
    output.err(`create-superadmin: could not open the history store: ${errorMessage(error)}`);
    return 1;
  }
  try {
    const result = await provisionSuperadmin({ users: store.history }, parsed.username, { reset: parsed.reset, now });
    if (result.outcome === "exists") {
      output.err(`User "${parsed.username}" already exists. Run again with --reset to set a new password (it signs the user out everywhere).`);
      return 1;
    }
    output.out(
      [
        result.outcome === "created" ? `Super admin created in ${store.description}.` : `Password reset in ${store.description}; the user was signed out everywhere.`,
        `  username: ${result.username}`,
        `  password: ${result.password}`,
        "This password is shown only this once and is not stored anywhere: save it now, then change it after signing in.",
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    output.err(`create-superadmin: ${errorMessage(error)}`);
    return 1;
  } finally {
    await store.history.close().catch(() => undefined);
  }
};
