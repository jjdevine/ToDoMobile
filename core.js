(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.TaskPlannerCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TASK_LINE = /^\s*(.+?)\s*-\s*(weekly|monthly|annual|daily|workdays|every\d+weeks|every\d+months)\s*-\s*(.+?)\s*$/i;
  const DAY_ALIASES = {
    mon: "monday",
    monday: "monday",
    tue: "tuesday",
    tues: "tuesday",
    tuesday: "tuesday",
    wed: "wednesday",
    wednesday: "wednesday",
    thu: "thursday",
    thur: "thursday",
    thurs: "thursday",
    thursday: "thursday",
    fri: "friday",
    friday: "friday",
    sat: "saturday",
    saturday: "saturday",
    sun: "sunday",
    sunday: "sunday",
  };

  function parseWeeklyQualifier(token) {
    return DAY_ALIASES[String(token || "").trim().toLowerCase()] || null;
  }

  function parseMonthlyQualifier(token) {
    const normalized = String(token || "").trim();
    if (!/^\d{1,2}$/.test(normalized)) return null;
    const value = Number(normalized);
    return value >= 1 && value <= 31 ? value : null;
  }

  function parseAnnualQualifier(token) {
    const match = String(token || "").trim().match(/^(\d{2})-(\d{2})$/);
    if (!match) return null;
    const month = Number(match[1]);
    const day = Number(match[2]);
    const date = new Date(2000, month - 1, day);
    if (date.getFullYear() !== 2000 || date.getMonth() + 1 !== month || date.getDate() !== day) {
      return null;
    }
    return { month, day };
  }

  function parseIntervalQualifier(token) {
    const match = String(token || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) {
      return null;
    }
    return { year, month, day };
  }

  function parseQualifierTokens(frequency, tokens) {
    if (frequency === "daily") {
      return tokens.length === 1 && tokens[0].toLowerCase() === "daily" ? [1] : null;
    }
    if (frequency === "workdays") {
      return tokens.length === 1 && tokens[0].toLowerCase() === "workdays" ? [1] : null;
    }

    let parsed;
    if (frequency === "weekly") {
      parsed = tokens.map(parseWeeklyQualifier);
    } else if (frequency === "monthly") {
      parsed = tokens.map(parseMonthlyQualifier);
    } else if (frequency === "annual") {
      parsed = tokens.map(parseAnnualQualifier);
    } else {
      const intervalMatch = frequency.match(/^every(\d+)(weeks|months)$/);
      if (!intervalMatch || Number(intervalMatch[1]) < 1 || tokens.length !== 1) return null;
      parsed = tokens.map(parseIntervalQualifier);
    }

    return parsed.length && parsed.every((value) => value !== null) ? parsed : null;
  }

  function parseProjectConfigDetailed(text) {
    const rules = [];
    const errors = [];

    String(text || "").split(/\r?\n/).forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) return;

      const match = line.match(TASK_LINE);
      if (!match) {
        errors.push({ line: index + 1, message: "Expected task-frequency-qualifier." });
        return;
      }

      const name = match[1].trim();
      const frequency = match[2].trim().toLowerCase();
      const qualifierTokens = match[3].split(",").map((part) => part.trim()).filter(Boolean);
      const qualifiers = parseQualifierTokens(frequency, qualifierTokens);

      if (!name) {
        errors.push({ line: index + 1, message: "Task name is required." });
      } else if (!qualifiers) {
        errors.push({ line: index + 1, message: "The qualifier is invalid for " + frequency + "." });
      } else {
        rules.push({
          name,
          frequency,
          qualifiers,
          signature: line.toLowerCase().replace(/\s+/g, ""),
        });
      }
    });

    return { rules, errors };
  }

  function parseProjectConfig(text) {
    return parseProjectConfigDetailed(text).rules;
  }

  function buildUserStorageKey(baseKey, userId) {
    const normalizedBaseKey = String(baseKey || "").trim();
    const normalizedUserId = String(userId || "").trim();
    return normalizedBaseKey && normalizedUserId ? normalizedBaseKey + "::" + normalizedUserId : null;
  }

  // ── Pure date helpers ────────────────────────────────────────────────────

  function isDateKey(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  function parseDateKey(dateKey) {
    const parts = dateKey.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function formatDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  function addDays(dateKey, amount) {
    const date = parseDateKey(dateKey);
    date.setDate(date.getDate() + amount);
    return formatDateKey(date);
  }

  const WEEKDAY_TOKENS = [
    "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
  ];

  function getWeekdayToken(dateKey) {
    return WEEKDAY_TOKENS[parseDateKey(dateKey).getDay()];
  }

  function ruleMatchesDate(rule, dateKey) {
    if (rule.frequency === "daily") return true;
    if (rule.frequency === "workdays") {
      const dow = parseDateKey(dateKey).getDay();
      return dow >= 1 && dow <= 5;
    }
    if (rule.frequency === "weekly") {
      return rule.qualifiers.indexOf(getWeekdayToken(dateKey)) >= 0;
    }
    if (rule.frequency === "monthly") {
      return rule.qualifiers.indexOf(parseDateKey(dateKey).getDate()) >= 0;
    }
    if (/^every\d+weeks$/i.test(rule.frequency)) {
      const n = parseInt(rule.frequency.match(/\d+/)[0], 10);
      const ref = rule.qualifiers[0];
      if (!ref) return false;
      const refDate = new Date(ref.year, ref.month - 1, ref.day);
      const checkDate = parseDateKey(dateKey);
      const diffMs = checkDate - refDate;
      if (diffMs < 0) return false;
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      return diffDays % (n * 7) === 0;
    }
    if (/^every\d+months$/i.test(rule.frequency)) {
      const n = parseInt(rule.frequency.match(/\d+/)[0], 10);
      const ref = rule.qualifiers[0];
      if (!ref) return false;
      const checkDate = parseDateKey(dateKey);
      if (checkDate.getDate() !== ref.day) return false;
      const monthDiff =
        (checkDate.getFullYear() - ref.year) * 12 + (checkDate.getMonth() + 1 - ref.month);
      return monthDiff >= 0 && monthDiff % n === 0;
    }
    // annual
    const date = parseDateKey(dateKey);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return rule.qualifiers.some((q) => q.month === month && q.day === day);
  }

  // ── Stable ID ────────────────────────────────────────────────────────────

  function createStableId(prefix, input) {
    let hash = 2166136261;
    const source = String(input || "");
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = (Math.imul ? Math.imul(hash, 16777619) : hash * 16777619) >>> 0;
    }
    return prefix + "_" + hash.toString(36);
  }

  // ── Server row → in-memory state ─────────────────────────────────────────

  function buildStateFromNormalizedRows(payload) {
    const projectsById = {};
    const descriptionsByTaskKey = {};
    const payloadProjects = Array.isArray(payload.projects) ? payload.projects : [];
    const payloadTasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    const payloadArchivedTasks = Array.isArray(payload.archivedTasks) ? payload.archivedTasks : [];
    const payloadGeneratedOccurrences = Array.isArray(payload.generatedOccurrences)
      ? payload.generatedOccurrences
      : [];
    const payloadProjectTags = Array.isArray(payload.projectTags) ? payload.projectTags : [];

    const state = {
      version: 1,
      updatedAt: "",
      projects: {},
      deletedProjects: {},
      defaultProjectId: null,
      defaultProjectUpdatedAt: "",
    };

    if (payload.userSettings) {
      const us = payload.userSettings;
      state.defaultProjectId =
        typeof us.default_project_id === "string" && us.default_project_id
          ? us.default_project_id
          : null;
      state.defaultProjectUpdatedAt =
        (typeof us.default_project_updated_at === "string" && us.default_project_updated_at)
          ? us.default_project_updated_at
          : (typeof us.updated_at === "string" && us.updated_at) ? us.updated_at : "";
      state.updatedAt = (typeof us.updated_at === "string" && us.updated_at) ? us.updated_at : "";
    }

    function laterIso(a, b) {
      const aMs = Date.parse(a || "");
      const bMs = Date.parse(b || "");
      if (isNaN(aMs) && isNaN(bMs)) return a || b || "";
      if (isNaN(aMs)) return b;
      if (isNaN(bMs)) return a;
      return aMs >= bMs ? a : b;
    }

    function makeProject(id, name) {
      return {
        projectId: id,
        name: name || "",
        tags: [],
        inactive: false,
        tasks: {},
        archived: {},
        generatedOccurrences: {},
        lastGeneratedThrough: null,
        updatedAt: "",
        deletedTasks: {},
        deletedArchivedTasks: {},
      };
    }

    function normalizeTag(value) {
      return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
    }

    payloadProjects.forEach((row) => {
      if (!row || typeof row.id !== "string" || !row.id) return;
      const id = row.id;
      projectsById[id] = makeProject(id, row.name || "");
      projectsById[id].inactive = !!row.inactive;
      projectsById[id].lastGeneratedThrough =
        isDateKey(row.last_generated_through) ? row.last_generated_through : null;
      projectsById[id].updatedAt =
        typeof row.updated_at === "string" && row.updated_at ? row.updated_at : "";
      state.updatedAt = laterIso(state.updatedAt, projectsById[id].updatedAt);
    });

    payloadProjectTags.forEach((row) => {
      if (!row || typeof row.project_id !== "string") return;
      const tag = normalizeTag(row.tag);
      if (!tag) return;
      if (!projectsById[row.project_id]) {
        projectsById[row.project_id] = makeProject(row.project_id, "");
      }
      const tags = projectsById[row.project_id].tags;
      if (!tags.includes(tag)) tags.push(tag);
      tags.sort((a, b) => a.localeCompare(b));
    });

    // Collect body (description) for active tasks and for archived tasks directly
    payloadTasks.forEach((row) => {
      if (!row || typeof row.project_id !== "string" || typeof row.id !== "string") return;
      descriptionsByTaskKey[row.project_id + "::" + row.id] = typeof row.body === "string" ? row.body : "";
    });
    payloadArchivedTasks.forEach((row) => {
      if (!row || typeof row.project_id !== "string" || typeof row.id !== "string") return;
      // Prefer the body carried directly on the archived row (present after migration 0005)
      if (typeof row.body === "string") {
        descriptionsByTaskKey[row.project_id + "::" + row.id] = row.body;
      }
    });

    function normalizeTaskRow(row, archived) {
      const key = row.project_id + "::" + row.id;
      return {
        id: row.id,
        projectId: row.project_id,
        name: String(row.name || "").trim(),
        description: descriptionsByTaskKey[key] || "",
        dueDate: isDateKey(row.due_date) ? row.due_date : null,
        source: row.source === "generated" ? "generated" : "manual",
        generatedKey: typeof row.generated_key === "string" && row.generated_key ? row.generated_key : null,
        pinned: !!row.pinned,
        endOfDay: !!row.end_of_day,
        createdAt: typeof row.created_at === "string" ? row.created_at : "",
        updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
        completedAt: archived && typeof row.completed_at === "string" ? row.completed_at : null,
      };
    }

    payloadTasks.forEach((row) => {
      if (!row || typeof row.project_id !== "string" || typeof row.id !== "string") return;
      if (!String(row.name || "").trim()) return;
      if (!projectsById[row.project_id]) projectsById[row.project_id] = makeProject(row.project_id, "");
      const task = normalizeTaskRow(row, false);
      projectsById[row.project_id].tasks[row.id] = task;
      projectsById[row.project_id].updatedAt = laterIso(projectsById[row.project_id].updatedAt, task.updatedAt);
      state.updatedAt = laterIso(state.updatedAt, task.updatedAt);
    });

    payloadArchivedTasks.forEach((row) => {
      if (!row || typeof row.project_id !== "string" || typeof row.id !== "string") return;
      if (!String(row.name || "").trim()) return;
      if (!projectsById[row.project_id]) projectsById[row.project_id] = makeProject(row.project_id, "");
      const task = normalizeTaskRow(row, true);
      projectsById[row.project_id].archived[row.id] = task;
      projectsById[row.project_id].updatedAt = laterIso(projectsById[row.project_id].updatedAt, task.updatedAt);
      state.updatedAt = laterIso(state.updatedAt, task.updatedAt);
    });

    payloadGeneratedOccurrences.forEach((row) => {
      if (!row || typeof row.project_id !== "string" || typeof row.occurrence_key !== "string") return;
      if (!projectsById[row.project_id]) projectsById[row.project_id] = makeProject(row.project_id, "");
      const createdAt = typeof row.created_at === "string" ? row.created_at : "";
      projectsById[row.project_id].generatedOccurrences[row.occurrence_key] = {
        createdAt,
        taskId: typeof row.task_id === "string" && row.task_id ? row.task_id : null,
        dueDate: isDateKey(row.due_date) ? row.due_date : null,
        taskName: typeof row.task_name === "string" ? row.task_name : "",
      };
      state.updatedAt = laterIso(state.updatedAt, createdAt);
    });

    state.projects = projectsById;
    return state;
  }

  return {
    addDays,
    buildStateFromNormalizedRows,
    buildUserStorageKey,
    createStableId,
    isDateKey,
    parseAnnualQualifier,
    parseIntervalQualifier,
    parseMonthlyQualifier,
    parseProjectConfig,
    parseProjectConfigDetailed,
    parseWeeklyQualifier,
    ruleMatchesDate,
  };
});