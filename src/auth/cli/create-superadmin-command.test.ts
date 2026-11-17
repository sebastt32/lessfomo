import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPassword } from "../domain/password-hash.js";
import { SqliteHistoryRecorder } from "../../history/infrastructure/sqlite/sqlite-history-recorder.js";
import { runCreateSuperadmin } from "./create-superadmin-command.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "lessfomo-superadmin-"));
  dirs.push(dir);
  const path = join(dir, "history.db");
  const run = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCreateSuperadmin(args, { LESSFOMO_DB_PATH: path }, { out: (line) => out.push(line), err: (line) => err.push(line) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const inspect = async <T>(work: (history: SqliteHistoryRecorder) => Promise<T>): Promise<T> => {
    const history = new SqliteHistoryRecorder(path);
    try {
      return await work(history);
    } finally {
      await history.close();
    }
  };
  return { run, inspect };
};

const passwordIn = (out: string): string => /password: (\S+)/.exec(out)?.[1] ?? "";

describe("create-superadmin", () => {
  it("creates superadmin with a random URL-safe password of 24+ characters, printed once and stored only hashed", async () => {
    const { run, inspect } = setup();

    const first = await run();

    expect(first.code).toBe(0);
    expect(first.err).toBe("");
    expect(first.out).toContain("username: superadmin");
    const password = passwordIn(first.out);
    expect(password).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect(first.out.split(password)).toHaveLength(2);
    const user = await inspect((history) => history.findUserByUsername("superadmin"));
    expect(user).toMatchObject({ username: "superadmin", role: "superadmin" });
    expect(user!.passwordHash).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(user!.passwordHash).not.toContain(password);
    expect(await verifyPassword(password, user!.passwordHash)).toBe(true);
  });

  it("accepts another username and generates a different password each time", async () => {
    const { run, inspect } = setup();

    const first = await run("alice");
    const second = await run("bob");

    expect([first.code, second.code]).toEqual([0, 0]);
    expect(first.out).toContain("username: alice");
    expect(passwordIn(first.out)).not.toBe(passwordIn(second.out));
    expect((await inspect((history) => history.findUserByUsername("ALICE")))?.role).toBe("superadmin");
  });

  it("exits non-zero with a clear message when the user exists and --reset was not given, changing nothing", async () => {
    const { run, inspect } = setup();
    const created = await run();
    const before = await inspect((history) => history.findUserByUsername("superadmin"));

    const again = await run("SuperAdmin");

    expect(again.code).toBe(1);
    expect(again.out).toBe("");
    expect(again.err).toContain('User "SuperAdmin" already exists');
    expect(again.err).toContain("--reset");
    expect(await inspect((history) => history.findUserByUsername("superadmin"))).toEqual(before);
    expect(passwordIn(created.out)).not.toBe("");
  });

  it("--reset sets a new password and deletes that user's sessions only", async () => {
    const { run, inspect } = setup();
    const created = await run();
    await run("other");
    await inspect(async (history) => {
      const now = new Date();
      const later = new Date(now.getTime() + 60_000);
      const admin = (await history.findUserByUsername("superadmin"))!;
      const other = (await history.findUserByUsername("other"))!;
      await history.createSession({ tokenHash: "a".repeat(64), userId: admin.id, createdAt: now, lastSeenAt: now, expiresAt: later });
      await history.createSession({ tokenHash: "b".repeat(64), userId: other.id, createdAt: now, lastSeenAt: now, expiresAt: later });
    });

    const reset = await run("--reset");

    expect(reset.code).toBe(0);
    const password = passwordIn(reset.out);
    expect(password).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect(password).not.toBe(passwordIn(created.out));
    await inspect(async (history) => {
      const user = (await history.findUserByUsername("superadmin"))!;
      expect(await verifyPassword(password, user.passwordHash)).toBe(true);
      expect(await verifyPassword(passwordIn(created.out), user.passwordHash)).toBe(false);
      expect(await history.findSession("a".repeat(64))).toBeNull();
      expect(await history.findSession("b".repeat(64))).not.toBeNull();
    });
  });

  it("--reset creates the user when it does not exist yet", async () => {
    const { run, inspect } = setup();

    const reset = await run("carol", "--reset");

    expect(reset.code).toBe(0);
    expect(reset.out).toContain("username: carol");
    expect(await inspect((history) => history.findUserByUsername("carol"))).not.toBeNull();
  });

  it("rejects an invalid username, an unknown option or extra arguments with usage, storing nothing", async () => {
    const { run, inspect } = setup();

    for (const args of [["bad name"], ["--force"], ["a", "b"], ["x".repeat(65)], [""]]) {
      const result = await run(...args);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.out).toBe("");
      expect(result.err).toContain("Usage: node dist/create-superadmin.js [username] [--reset]");
    }
    expect(await inspect(async (history) => history.query("SELECT COUNT(*) AS n FROM users")[0]?.["n"])).toBe(0);
  });

  it("exits non-zero without a stack trace when the history store cannot be opened", async () => {
    const out: string[] = [];
    const err: string[] = [];

    const code = await runCreateSuperadmin(
      [],
      { DATABASE_URL: "postgres://lessfomo:secret-pass@127.0.0.1:1/lessfomo" },
      { out: (line) => out.push(line), err: (line) => err.push(line) },
    );

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("could not open the history store");
    expect(err.join("\n")).not.toContain("secret-pass");
  });
});
