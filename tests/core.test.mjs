import { describe, expect, it } from "vitest";
import core from "../core.js";

const {
  buildUserStorageKey,
  parseAnnualQualifier,
  parseIntervalQualifier,
  parseProjectConfigDetailed,
} = core;

describe("offline cache isolation", () => {
  it("requires and includes the authenticated user id", () => {
    expect(buildUserStorageKey("task_planner_state_v1", "user-a")).toBe("task_planner_state_v1::user-a");
    expect(buildUserStorageKey("task_planner_state_v1", "user-b")).toBe("task_planner_state_v1::user-b");
    expect(buildUserStorageKey("task_planner_state_v1", "")).toBeNull();
  });
});

describe("recurring project configuration", () => {
  it("parses every supported cadence", () => {
    const result = parseProjectConfigDetailed([
      "Daily task-daily-daily",
      "Weekday task-workdays-workdays",
      "Weekly task-weekly-mon,friday",
      "Monthly task-monthly-1,31",
      "Annual task-annual-02-29",
      "Fortnightly task-every2weeks-2026-04-28",
      "Quarterly task-every3months-2026-01-15",
    ].join("\n"));

    expect(result.errors).toEqual([]);
    expect(result.rules).toHaveLength(7);
    expect(result.rules[2].qualifiers).toEqual(["monday", "friday"]);
  });

  it("rejects invalid lines rather than partially accepting them", () => {
    const result = parseProjectConfigDetailed([
      "Valid task-weekly-monday",
      "Bad weekday-weekly-monday,noday",
      "Bad daily-daily-whenever",
      "Bad interval-every0weeks-2026-01-01",
      "Bad annual-annual-02-30",
    ].join("\n"));

    expect(result.rules).toHaveLength(1);
    expect(result.errors.map((error) => error.line)).toEqual([2, 3, 4, 5]);
  });

  it("validates calendar dates by round-tripping", () => {
    expect(parseAnnualQualifier("02-29")).toEqual({ month: 2, day: 29 });
    expect(parseAnnualQualifier("02-30")).toBeNull();
    expect(parseIntervalQualifier("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseIntervalQualifier("2025-02-29")).toBeNull();
  });
});