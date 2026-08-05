import { describe, expect, it } from "vitest";
import core from "../core.js";

const {
  buildStateFromNormalizedRows,
  createStableId,
  parseProjectConfigDetailed,
  ruleMatchesDate,
} = core;

// ---------------------------------------------------------------------------
// Stable ID determinism
// ---------------------------------------------------------------------------
describe("createStableId", () => {
  it("returns the same value for the same inputs", () => {
    const a = createStableId("task", "project-a|review-daily|2026-08-05");
    const b = createStableId("task", "project-a|review-daily|2026-08-05");
    expect(a).toBe(b);
    expect(a).toMatch(/^task_/);
  });

  it("returns different values for different inputs", () => {
    const a = createStableId("task", "project-a|review|2026-08-05");
    const b = createStableId("task", "project-a|review|2026-08-06");
    expect(a).not.toBe(b);
  });

  it("produces idempotent occurrence keys across generation runs", () => {
    // Simulates two separate generation runs for the same rule on the same date
    const key1 = createStableId("task", "proj|checkin-weekly-monday|2026-08-10");
    const key2 = createStableId("task", "proj|checkin-weekly-monday|2026-08-10");
    expect(key1).toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------
describe("ruleMatchesDate", () => {
  it("daily rule matches every day", () => {
    const rule = { frequency: "daily", qualifiers: [1] };
    expect(ruleMatchesDate(rule, "2026-08-01")).toBe(true);
    expect(ruleMatchesDate(rule, "2026-08-02")).toBe(true);
  });

  it("workdays rule matches Mon–Fri only", () => {
    const rule = { frequency: "workdays", qualifiers: [1] };
    expect(ruleMatchesDate(rule, "2026-08-03")).toBe(true);  // Monday
    expect(ruleMatchesDate(rule, "2026-08-07")).toBe(true);  // Friday
    expect(ruleMatchesDate(rule, "2026-08-08")).toBe(false); // Saturday
    expect(ruleMatchesDate(rule, "2026-08-09")).toBe(false); // Sunday
  });

  it("weekly rule matches the correct weekday", () => {
    const rule = { frequency: "weekly", qualifiers: ["monday"] };
    expect(ruleMatchesDate(rule, "2026-08-03")).toBe(true);  // Monday
    expect(ruleMatchesDate(rule, "2026-08-04")).toBe(false); // Tuesday
  });

  it("monthly rule matches the correct day-of-month", () => {
    const rule = { frequency: "monthly", qualifiers: [15] };
    expect(ruleMatchesDate(rule, "2026-08-15")).toBe(true);
    expect(ruleMatchesDate(rule, "2026-08-14")).toBe(false);
  });

  it("annual rule matches the correct day and month", () => {
    const rule = { frequency: "annual", qualifiers: [{ month: 8, day: 5 }] };
    expect(ruleMatchesDate(rule, "2026-08-05")).toBe(true);
    expect(ruleMatchesDate(rule, "2027-08-05")).toBe(true);
    expect(ruleMatchesDate(rule, "2026-08-06")).toBe(false);
  });

  it("every-N-weeks rule matches exactly on interval boundaries", () => {
    const rule = { frequency: "every2weeks", qualifiers: [{ year: 2026, month: 4, day: 28 }] };
    expect(ruleMatchesDate(rule, "2026-04-28")).toBe(true);
    expect(ruleMatchesDate(rule, "2026-05-12")).toBe(true);  // +14 days
    expect(ruleMatchesDate(rule, "2026-05-05")).toBe(false); // +7 days (not on interval)
    expect(ruleMatchesDate(rule, "2026-04-21")).toBe(false); // before start date
  });

  it("every-N-months rule matches same day-of-month at correct month intervals", () => {
    const rule = { frequency: "every3months", qualifiers: [{ year: 2026, month: 1, day: 15 }] };
    expect(ruleMatchesDate(rule, "2026-01-15")).toBe(true);
    expect(ruleMatchesDate(rule, "2026-04-15")).toBe(true);
    expect(ruleMatchesDate(rule, "2026-07-15")).toBe(true);
    expect(ruleMatchesDate(rule, "2026-02-15")).toBe(false); // wrong interval
    expect(ruleMatchesDate(rule, "2026-04-14")).toBe(false); // wrong day
  });
});

// ---------------------------------------------------------------------------
// Server row → in-memory state reconstruction
// ---------------------------------------------------------------------------
describe("buildStateFromNormalizedRows", () => {
  function makeProject(id, name) {
    return { id, name, inactive: false, last_generated_through: null, updated_at: "2026-08-01T10:00:00Z" };
  }

  function makeTask(projectId, id, name, body = "") {
    return {
      id, project_id: projectId, name, body,
      due_date: "2026-08-05", source: "manual", generated_key: null,
      pinned: false, end_of_day: false,
      created_at: "2026-08-01T10:00:00Z", updated_at: "2026-08-01T10:00:00Z",
    };
  }

  function makeArchivedTask(projectId, id, name, body = "") {
    return {
      id, project_id: projectId, name, body,
      due_date: "2026-08-01", source: "manual", generated_key: null,
      pinned: false, end_of_day: false,
      completed_at: "2026-08-02T09:00:00Z",
      created_at: "2026-08-01T10:00:00Z", updated_at: "2026-08-02T09:00:00Z",
    };
  }

  it("reconstructs a project with active tasks from server rows", () => {
    const state = buildStateFromNormalizedRows({
      userSettings: { default_project_id: "proj-a", updated_at: "2026-08-01T10:00:00Z" },
      projects: [makeProject("proj-a", "Work")],
      tasks: [makeTask("proj-a", "task-1", "Write report", "Detailed notes")],
      archivedTasks: [],
      generatedOccurrences: [],
      projectTags: [],
    });

    expect(state.defaultProjectId).toBe("proj-a");
    expect(state.projects["proj-a"].name).toBe("Work");
    const task = state.projects["proj-a"].tasks["task-1"];
    expect(task.name).toBe("Write report");
    expect(task.description).toBe("Detailed notes");
    expect(task.dueDate).toBe("2026-08-05");
  });

  it("preserves description on archived tasks via body column", () => {
    // This tests the critical migration-0005 fix: archived tasks carry body directly
    const state = buildStateFromNormalizedRows({
      projects: [makeProject("proj-a", "Work")],
      tasks: [],
      archivedTasks: [makeArchivedTask("proj-a", "task-1", "Done task", "My archived description")],
      generatedOccurrences: [],
      projectTags: [],
    });

    const archived = state.projects["proj-a"].archived["task-1"];
    expect(archived.name).toBe("Done task");
    expect(archived.description).toBe("My archived description");
    expect(archived.completedAt).toBe("2026-08-02T09:00:00Z");
  });

  it("archived task description is empty string when body is absent", () => {
    const row = makeArchivedTask("proj-a", "task-2", "No description task");
    delete row.body; // simulate missing body column from old server data
    const state = buildStateFromNormalizedRows({
      projects: [makeProject("proj-a", "Work")],
      tasks: [],
      archivedTasks: [row],
      generatedOccurrences: [],
      projectTags: [],
    });

    expect(state.projects["proj-a"].archived["task-2"].description).toBe("");
  });

  it("tasks with empty name are dropped from state", () => {
    const state = buildStateFromNormalizedRows({
      projects: [makeProject("proj-a", "Work")],
      tasks: [makeTask("proj-a", "task-bad", "")],
      archivedTasks: [],
      generatedOccurrences: [],
      projectTags: [],
    });

    expect(state.projects["proj-a"].tasks["task-bad"]).toBeUndefined();
  });

  it("tags from projectTags rows are attached to the correct project", () => {
    const state = buildStateFromNormalizedRows({
      projects: [makeProject("proj-a", "Work")],
      tasks: [],
      archivedTasks: [],
      generatedOccurrences: [],
      projectTags: [
        { project_id: "proj-a", tag: "finance" },
        { project_id: "proj-a", tag: "ADMIN" },
      ],
    });

    expect(state.projects["proj-a"].tags).toEqual(["admin", "finance"]); // sorted, lowercased
  });
});

// ---------------------------------------------------------------------------
// Config parsing → rule matching round-trip
// ---------------------------------------------------------------------------
describe("config parse to match round-trip", () => {
  it("generates only matching dates from a multi-cadence config", () => {
    const config = [
      "Daily standup-daily-daily",
      "Weekly review-weekly-friday",
      "Monthly billing-monthly-1",
    ].join("\n");

    const { rules, errors } = parseProjectConfigDetailed(config);
    expect(errors).toEqual([]);
    expect(rules).toHaveLength(3);

    const [daily, weekly, monthly] = rules;

    // 2026-08-07 is a Friday
    expect(ruleMatchesDate(daily, "2026-08-07")).toBe(true);
    expect(ruleMatchesDate(weekly, "2026-08-07")).toBe(true);
    expect(ruleMatchesDate(monthly, "2026-08-07")).toBe(false);

    // 2026-08-01 is a Saturday
    expect(ruleMatchesDate(daily, "2026-08-01")).toBe(true);
    expect(ruleMatchesDate(weekly, "2026-08-01")).toBe(false);
    expect(ruleMatchesDate(monthly, "2026-08-01")).toBe(true);
  });
});
