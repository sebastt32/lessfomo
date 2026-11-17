import { describe, expect, it } from "vitest";
import { AuthError } from "./auth-error.js";
import { WorkGate } from "./work-gate.js";

/** A piece of work the test finishes by hand. */
const job = () => {
  let finish = (_value: string): void => undefined;
  let fail = (_error: Error): void => undefined;
  let started = false;
  const done = new Promise<string>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return {
    work: () => {
      started = true;
      return done;
    },
    started: () => started,
    finish,
    fail,
  };
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("WorkGate", () => {
  it("runs at most `maxConcurrent` pieces of work at once and the queued ones in order", async () => {
    const gate = new WorkGate({ maxConcurrent: 2, maxQueued: 5 });
    const jobs = [job(), job(), job(), job()];
    const results = jobs.map((each) => gate.run(each.work));
    await tick();

    expect(jobs.map((each) => each.started())).toEqual([true, true, false, false]);

    jobs[1]!.finish("b");
    await tick();
    expect(jobs.map((each) => each.started())).toEqual([true, true, true, false]);

    jobs[0]!.finish("a");
    jobs[2]!.finish("c");
    jobs[3]!.finish("d");
    expect(await Promise.all(results)).toEqual(["a", "b", "c", "d"]);
  });

  it("refuses with SERVER_BUSY, without running the work, when the queue is full", async () => {
    const gate = new WorkGate({ maxConcurrent: 1, maxQueued: 2 });
    const jobs = [job(), job(), job()];
    const accepted = jobs.map((each) => gate.run(each.work));
    const refused = job();

    const error = await gate.run(refused.work).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: "SERVER_BUSY", retryAfterSeconds: 2 });
    expect(refused.started()).toBe(false);

    jobs.forEach((each, index) => each.finish(String(index)));
    expect(await Promise.all(accepted)).toEqual(["0", "1", "2"]);
    // Room again once the queue drained.
    expect(await gate.run(async () => "later")).toBe("later");
  });

  it("frees its slot when the work fails", async () => {
    const gate = new WorkGate({ maxConcurrent: 1, maxQueued: 0 });
    const failing = job();
    const failed = gate.run(failing.work).catch((caught: unknown) => caught);

    failing.fail(new Error("boom"));

    expect(await failed).toMatchObject({ message: "boom" });
    expect(await gate.run(async () => "next")).toBe("next");
  });
});
