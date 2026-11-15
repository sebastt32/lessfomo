import { describe, expect, it } from "vitest";
import {
  FIRST_MILESTONE,
  followingMilestone,
  isDead,
  milestoneOffsetMs,
  resolveDueMilestone,
} from "./milestone-schedule.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DETECTED = new Date("2026-11-14T00:00:00.000Z");
const at = (offsetMs: number) => new Date(DETECTED.getTime() + offsetMs);

describe("milestone schedule", () => {
  it("follows 0m, 1m, 5m, 10m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 24h, then daily to d7, then weekly", () => {
    const names: string[] = [FIRST_MILESTONE];
    while (names.length < 22) names.push(followingMilestone(names.at(-1) as string));

    expect(names).toEqual([
      "0m", "1m", "5m", "10m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "24h",
      "d2", "d3", "d4", "d5", "d6", "d7", "w2", "w3", "w4", "w5",
    ]);
  });

  it("places every milestone at its offset from the creation time, weeks past w8 included", () => {
    expect(milestoneOffsetMs("0m")).toBe(0);
    expect(milestoneOffsetMs("5m")).toBe(5 * MINUTE);
    expect(milestoneOffsetMs("12h")).toBe(12 * HOUR);
    expect(milestoneOffsetMs("d2")).toBe(2 * DAY);
    expect(milestoneOffsetMs("w2")).toBe(14 * DAY);
    expect(milestoneOffsetMs("w12")).toBe(84 * DAY);
    expect(milestoneOffsetMs("event:new-peak")).toBeNull();
    expect(milestoneOffsetMs("w1")).toBeNull();
  });

  it("is not due before the next milestone's time", () => {
    expect(resolveDueMilestone(DETECTED, "5m", at(5 * MINUTE - 1))).toBeNull();
  });

  it("takes the due milestone and schedules the following one", () => {
    expect(resolveDueMilestone(DETECTED, "5m", at(5 * MINUTE + 3_000))).toEqual({
      milestone: "5m",
      following: "10m",
      followingAt: at(10 * MINUTE),
    });
  });

  it("continues weekly after d7", () => {
    expect(resolveDueMilestone(DETECTED, "d7", at(7 * DAY))).toEqual({
      milestone: "d7",
      following: "w2",
      followingAt: at(14 * DAY),
    });
    expect(resolveDueMilestone(DETECTED, "w9", at(63 * DAY))?.followingAt).toEqual(at(70 * DAY));
  });

  it("takes only the latest of the milestones missed while stopped, once, and resumes after it", () => {
    // Stopped after the 2m mark, restarted at 17m: 5m, 10m and 15m were missed.
    expect(resolveDueMilestone(DETECTED, "5m", at(17 * MINUTE))).toEqual({
      milestone: "15m",
      following: "30m",
      followingAt: at(30 * MINUTE),
    });
  });

  it("treats a token as dead after 24 hours without trades", () => {
    const now = at(3 * DAY);

    expect(isDead(at(2 * DAY), DETECTED, now)).toBe(true);
    expect(isDead(at(2 * DAY + 1), DETECTED, now)).toBe(false);
    expect(isDead(null, DETECTED, at(DAY))).toBe(true);
    expect(isDead(null, DETECTED, at(DAY - 1))).toBe(false);
  });
});
