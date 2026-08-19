(function () {
  "use strict";

  const STORAGE_KEY = "task_planner_state_v1";
  const PROJECT_CONFIGS_STORAGE_KEY = "task_planner_project_configs_v1";
  const PROJECT_TAG_FILTERS_STORAGE_KEY = "task_planner_project_tag_filters_v1";
  const RECURRING_TASK_DESCRIPTIONS_STORAGE_KEY = "task_planner_recurring_task_descriptions_v1";
  const USER_SETTINGS_TABLE = "user_settings";
  const PROJECTS_TABLE = "projects";
  const TASKS_TABLE = "tasks";
  const ARCHIVED_TASKS_TABLE = "archived_tasks";
  const GENERATED_OCCURRENCES_TABLE = "generated_occurrences";
  const RECURRING_TASK_DESCRIPTIONS_TABLE = "recurring_task_descriptions";
  const TAGS_TABLE = "tags";
  const PROJECT_TAGS_TABLE = "project_tags";
  const BACKUP_DOWNLOAD_DELAY_MS = 150;
  const TOAST_DISPLAY_MS = 4000;
  const SERVER_ERROR_TOAST_COOLDOWN_MS = 15000;
  const RECURRING_DESC_PREVIEW_MAX_LENGTH = 60;
  const SUPABASE_PLACEHOLDER = "https://YOUR_PROJECT_REF.supabase.co";
  const TASK_LINE = /^\s*(.+?)\s*-\s*(weekly|monthly|annual|daily|workdays|every\d+weeks|every\d+months)\s*-\s*(.+?)\s*$/i;
  const WEEKDAY_TOKENS = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
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

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => document.querySelectorAll(selector);

  const SUPABASE_KEY =
    typeof SUPABASE_ANON_KEY !== "undefined" && SUPABASE_ANON_KEY
      ? SUPABASE_ANON_KEY
      : typeof SUPABASE_PUBLISHABLE_KEY !== "undefined" && SUPABASE_PUBLISHABLE_KEY
        ? SUPABASE_PUBLISHABLE_KEY
        : "";

  const supabaseConfigured =
    typeof window.supabase !== "undefined" &&
    typeof SUPABASE_URL !== "undefined" &&
    SUPABASE_URL &&
    SUPABASE_URL !== SUPABASE_PLACEHOLDER &&
    !/YOUR_PROJECT_REF/i.test(SUPABASE_URL) &&
    SUPABASE_KEY &&
    !/YOUR_SUPABASE_ANON_KEY/i.test(SUPABASE_KEY) &&
    !/YOUR_SUPABASE_PUBLISHABLE_KEY/i.test(SUPABASE_KEY);

  const supabase = supabaseConfigured
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        global: {
          headers: {
            apikey: SUPABASE_KEY,
          },
        },
      })
    : null;

  let currentUser = null;
  let appEntered = false;
  let eventsBound = false;
  let lastPullAt = 0;
  let currentProjectId = null;
  let selectedDate = todayKey();
  let selectedTaskView = "day";
  let condensedMode = true;
  let countdownEnabled = true;
  let expandedTaskCards = {};
  let deferTaskId = null;
  let editTaskId = null;
  let configModalProjectId = null;

  let projectConfigs = {};
  let projectConfigTexts = {};
  // Project-scoped default descriptions for recurring tasks.
  // Shape: { [projectId]: { [taskName]: description } }
  // Keyed by exact task name (case-sensitive). Loaded from localStorage on
  // startup and fetched from Supabase when signed in.
  let recurringTaskDescriptions = {};
  let selectedProjectTagFilters = new Set();
  let showProjectActions = false;
  let appState = createEmptyState();
  let lastServerErrorToastAt = 0;
  let lastPullErrorMessage = "";
  let appMode = "loading";
  let serverCommandInFlight = false;
  const COMPLETE_COUNTDOWN_SECONDS = 3;
  let pendingTaskCompletions = {};

  function nowIso() {
    return new Date().toISOString();
  }

  function createEmptyState() {
    const timestamp = nowIso();
    return {
      version: 1,
      updatedAt: timestamp,
      projects: {},
      deletedProjects: {},
      defaultProjectId: null,
      defaultProjectUpdatedAt: timestamp,
    };
  }

  function createEmptyProjectState(projectId, name) {
    return {
      projectId,
      name: name || "",
      tags: [],
      inactive: false,
      tasks: {},
      archived: {},
      generatedOccurrences: {},
      lastGeneratedThrough: null,
      updatedAt: nowIso(),
      deletedTasks: {},
      deletedArchivedTasks: {},
    };
  }

  function getPendingTaskCompletion(taskId) {
    return pendingTaskCompletions[taskId] || null;
  }

  function getTaskCompletionCountdownLabel(taskId) {
    const pending = getPendingTaskCompletion(taskId);
    if (!pending) return null;
    return "Complete " + pending.remaining + "..";
  }

  function renderCurrentTaskSections() {
    if (currentProjectId) renderTaskSections(currentProjectId);
  }

  function clearPendingTaskCompletion(taskId) {
    const pending = getPendingTaskCompletion(taskId);
    if (!pending) return false;
    if (pending.timerId) window.clearTimeout(pending.timerId);
    delete pendingTaskCompletions[taskId];
    return true;
  }

  function cancelPendingTaskCompletion(taskId) {
    const cancelled = clearPendingTaskCompletion(taskId);
    if (cancelled) renderCurrentTaskSections();
  }

  function scheduleTaskCompletionTick(taskId) {
    const pending = getPendingTaskCompletion(taskId);
    if (!pending) return;
    pending.timerId = window.setTimeout(async () => {
      const currentPending = getPendingTaskCompletion(taskId);
      if (!currentPending) return;
      if (currentPending.remaining <= 1) {
        delete pendingTaskCompletions[taskId];
        renderCurrentTaskSections();
        await completeTask(taskId, { skipDelay: true });
        return;
      }
      currentPending.remaining -= 1;
      renderCurrentTaskSections();
      scheduleTaskCompletionTick(taskId);
    }, 1000);
  }

  function queueTaskCompletion(taskId) {
    if (clearPendingTaskCompletion(taskId)) {
      renderCurrentTaskSections();
      return;
    }
    if (!countdownEnabled) {
      completeTask(taskId, { skipDelay: true });
      return;
    }
    pendingTaskCompletions[taskId] = {
      remaining: COMPLETE_COUNTDOWN_SECONDS,
      timerId: null,
    };
    renderCurrentTaskSections();
    scheduleTaskCompletionTick(taskId);
  }

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

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

  function todayKey() {
    return formatDateKey(new Date());
  }

  function addDays(dateKey, amount) {
    const date = parseDateKey(dateKey);
    date.setDate(date.getDate() + amount);
    return formatDateKey(date);
  }

  function compareDateKeys(a, b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function maxDateKey(a, b) {
    return compareDateKeys(a, b) >= 0 ? a : b;
  }

  function enumerateDateKeys(startDate, endDate) {
    const out = [];
    let cursor = startDate;
    while (compareDateKeys(cursor, endDate) <= 0) {
      out.push(cursor);
      cursor = addDays(cursor, 1);
    }
    return out;
  }

  function compareIso(a, b) {
    const aMs = Date.parse(a || "");
    const bMs = Date.parse(b || "");
    if (Number.isNaN(aMs) && Number.isNaN(bMs)) return 0;
    if (Number.isNaN(aMs)) return -1;
    if (Number.isNaN(bMs)) return 1;
    return aMs - bMs;
  }

  function laterIso(a, b) {
    return compareIso(a, b) >= 0 ? a : b;
  }

  function normalizeTaskRecord(raw, projectId, archived) {
    if (!isPlainObject(raw)) return null;
    const id = typeof raw.id === "string" && raw.id ? raw.id : null;
    if (!id) return null;

    const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : nowIso();
    const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;
    const completedAt = archived && typeof raw.completedAt === "string" ? raw.completedAt : null;
    const dueDate = isDateKey(raw.dueDate) ? raw.dueDate : null;
    const source = raw.source === "generated" ? "generated" : "manual";

    return {
      id,
      projectId: typeof raw.projectId === "string" && raw.projectId ? raw.projectId : projectId,
      name: String(raw.name || "").trim(),
      description: String(raw.description || "").trim(),
      dueDate,
      source,
      generatedKey: typeof raw.generatedKey === "string" && raw.generatedKey ? raw.generatedKey : null,
      createdAt,
      updatedAt,
      completedAt,
      pinned: typeof raw.pinned === "boolean" ? raw.pinned : false,
      endOfDay: typeof raw.endOfDay === "boolean" ? raw.endOfDay : false,
    };
  }

  function normalizeTaskMap(rawMap, projectId, archived) {
    const normalized = {};
    if (!isPlainObject(rawMap)) return normalized;

    Object.keys(rawMap).forEach((taskId) => {
      const record = normalizeTaskRecord(rawMap[taskId], projectId, archived);
      if (record && record.name) {
        normalized[taskId] = record;
      }
    });

    return normalized;
  }

  function normalizeTimestampMap(rawMap) {
    const normalized = {};
    if (!isPlainObject(rawMap)) return normalized;

    Object.keys(rawMap).forEach((key) => {
      const value = rawMap[key];
      if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
        normalized[key] = value;
      }
    });

    return normalized;
  }

  function normalizeGeneratedOccurrences(rawMap) {
    const normalized = {};
    if (!isPlainObject(rawMap)) return normalized;

    Object.keys(rawMap).forEach((key) => {
      const entry = rawMap[key];
      if (typeof entry === "string") {
        normalized[key] = {
          createdAt: entry,
          taskId: null,
          dueDate: null,
          taskName: "",
        };
        return;
      }

      if (!isPlainObject(entry)) return;
      normalized[key] = {
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : nowIso(),
        taskId: typeof entry.taskId === "string" && entry.taskId ? entry.taskId : null,
        dueDate: isDateKey(entry.dueDate) ? entry.dueDate : null,
        taskName: typeof entry.taskName === "string" ? entry.taskName : "",
      };
    });

    return normalized;
  }

  function normalizeTagValue(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function normalizeTagList(rawTags) {
    if (!Array.isArray(rawTags)) return [];
    const uniqueTags = new Set();
    rawTags.forEach((rawTag) => {
      const normalizedTag = normalizeTagValue(rawTag);
      if (normalizedTag) {
        uniqueTags.add(normalizedTag);
      }
    });
    return Array.from(uniqueTags).sort((a, b) => a.localeCompare(b));
  }

  function parseTagInput(inputText) {
    if (!inputText) return [];
    return normalizeTagList(String(inputText).split(","));
  }

  function formatProjectTags(tags) {
    return normalizeTagList(tags).join(", ");
  }

  function normalizeProjectState(projectId, rawProject) {
    if (!isPlainObject(rawProject)) {
      return createEmptyProjectState(projectId, "");
    }

    return {
      projectId,
      name: typeof rawProject.name === "string" ? rawProject.name : "",
      tags: normalizeTagList(rawProject.tags),
      inactive: typeof rawProject.inactive === "boolean" ? rawProject.inactive : false,
      tasks: normalizeTaskMap(rawProject.tasks, projectId, false),
      archived: normalizeTaskMap(rawProject.archived, projectId, true),
      generatedOccurrences: normalizeGeneratedOccurrences(rawProject.generatedOccurrences),
      lastGeneratedThrough: isDateKey(rawProject.lastGeneratedThrough) ? rawProject.lastGeneratedThrough : null,
      updatedAt: typeof rawProject.updatedAt === "string" ? rawProject.updatedAt : nowIso(),
      deletedTasks: normalizeTimestampMap(rawProject.deletedTasks),
      deletedArchivedTasks: normalizeTimestampMap(rawProject.deletedArchivedTasks),
    };
  }

  function normalizeState(rawState) {
    const normalized = createEmptyState();
    if (!isPlainObject(rawState)) return normalized;

    normalized.version = Number(rawState.version) || 1;
    normalized.updatedAt = typeof rawState.updatedAt === "string" ? rawState.updatedAt : nowIso();
    normalized.projects = {};
    normalized.deletedProjects = normalizeTimestampMap(rawState.deletedProjects);
    normalized.defaultProjectId = typeof rawState.defaultProjectId === "string" ? rawState.defaultProjectId : null;
    normalized.defaultProjectUpdatedAt =
      typeof rawState.defaultProjectUpdatedAt === "string"
        ? rawState.defaultProjectUpdatedAt
        : normalized.updatedAt;

    if (isPlainObject(rawState.projects)) {
      Object.keys(rawState.projects).forEach((projectId) => {
        normalized.projects[projectId] = normalizeProjectState(projectId, rawState.projects[projectId]);
      });
    }

    return normalized;
  }

  function loadLocalState() {
    const storageKey = getUserStorageKey(STORAGE_KEY);
    if (!storageKey) {
      appState = createEmptyState();
      return false;
    }
    try {
      const raw = localStorage.getItem(storageKey);
      appState = raw ? normalizeState(JSON.parse(raw)) : createEmptyState();
      return !!raw;
    } catch (error) {
      console.warn("Failed to load local task state:", error);
      appState = createEmptyState();
      return false;
    }
  }

  function saveStateLocal() {
    const storageKey = getUserStorageKey(STORAGE_KEY);
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(appState));
    } catch (error) {
      console.warn("Failed to save local task state:", error);
    }
  }

  function getUserStorageKey(baseKey, userId) {
    const resolvedUserId = userId || (currentUser && currentUser.id);
    return window.TaskPlannerCore.buildUserStorageKey(baseKey, resolvedUserId);
  }

  function loadProjectTagFilters() {
    const storageKey = getUserStorageKey(PROJECT_TAG_FILTERS_STORAGE_KEY);
    if (!storageKey) {
      selectedProjectTagFilters = new Set();
      return;
    }
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      selectedProjectTagFilters = new Set(normalizeTagList(parsed));
    } catch (error) {
      console.warn("Failed to load project tag filters:", error);
      selectedProjectTagFilters = new Set();
    }
  }

  function saveProjectTagFilters() {
    const storageKey = getUserStorageKey(PROJECT_TAG_FILTERS_STORAGE_KEY);
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(Array.from(selectedProjectTagFilters)));
    } catch (error) {
      console.warn("Failed to save project tag filters:", error);
    }
  }

  function resetSyncTracking() {
    lastPullAt = 0;
  }

  function clearAllLocalPersistence(userId) {
    try {
      [
        STORAGE_KEY,
        PROJECT_CONFIGS_STORAGE_KEY,
        PROJECT_TAG_FILTERS_STORAGE_KEY,
        RECURRING_TASK_DESCRIPTIONS_STORAGE_KEY,
      ].forEach((baseKey) => {
        const storageKey = getUserStorageKey(baseKey, userId);
        if (storageKey) localStorage.removeItem(storageKey);
      });
      // Remove pre-user-scoping data so it cannot leak into an authenticated session.
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(PROJECT_CONFIGS_STORAGE_KEY);
      localStorage.removeItem(PROJECT_TAG_FILTERS_STORAGE_KEY);
      localStorage.removeItem(RECURRING_TASK_DESCRIPTIONS_STORAGE_KEY);
    } catch (error) {
      console.warn("Failed to clear local persistence:", error);
    }
  }

  function buildStateFromNormalizedRows(payload) {
    const nextState = createEmptyState();
    const projectsById = {};
    const descriptionsByTaskKey = {};
    const payloadProjects = Array.isArray(payload.projects) ? payload.projects : [];
    const payloadTasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    const payloadArchivedTasks = Array.isArray(payload.archivedTasks) ? payload.archivedTasks : [];
    const payloadGeneratedOccurrences = Array.isArray(payload.generatedOccurrences) ? payload.generatedOccurrences : [];
    const payloadDescriptions = Array.isArray(payload.descriptions) ? payload.descriptions : [];
    const payloadProjectTags = Array.isArray(payload.projectTags) ? payload.projectTags : [];

    if (payload.userSettings) {
      nextState.defaultProjectId =
        typeof payload.userSettings.default_project_id === "string" && payload.userSettings.default_project_id
          ? payload.userSettings.default_project_id
          : null;
      nextState.defaultProjectUpdatedAt =
        typeof payload.userSettings.default_project_updated_at === "string" && payload.userSettings.default_project_updated_at
          ? payload.userSettings.default_project_updated_at
          : typeof payload.userSettings.updated_at === "string" && payload.userSettings.updated_at
            ? payload.userSettings.updated_at
            : nextState.defaultProjectUpdatedAt;
      nextState.updatedAt =
        typeof payload.userSettings.updated_at === "string" && payload.userSettings.updated_at
          ? payload.userSettings.updated_at
          : nextState.updatedAt;
    }

    payloadProjects.forEach((row) => {
      if (!row || typeof row.id !== "string" || !row.id) return;
      const projectId = row.id;
      projectsById[projectId] = {
        ...createEmptyProjectState(projectId, row.name || ""),
        name: typeof row.name === "string" ? row.name : "",
        inactive: !!row.inactive,
        lastGeneratedThrough:
          typeof row.last_generated_through === "string" && isDateKey(row.last_generated_through)
            ? row.last_generated_through
            : null,
        updatedAt:
          typeof row.updated_at === "string" && row.updated_at
            ? row.updated_at
            : nowIso(),
      };
      nextState.updatedAt = laterIso(nextState.updatedAt, projectsById[projectId].updatedAt);
    });

    payloadProjectTags.forEach((row) => {
      if (!row || typeof row.project_id !== "string") return;
      const projectId = row.project_id;
      const tag = normalizeTagValue(row.tag);
      if (!tag) return;
      if (!projectsById[projectId]) {
        projectsById[projectId] = createEmptyProjectState(projectId, "");
      }
      const projectTags = normalizeTagList(projectsById[projectId].tags);
      if (projectTags.indexOf(tag) >= 0) return;
      projectTags.push(tag);
      projectsById[projectId].tags = normalizeTagList(projectTags);
    });

    payloadTasks.forEach((row) => {
      if (!row || typeof row.project_id !== "string" || typeof row.id !== "string") return;
      const key = row.project_id + "::" + row.id;
      descriptionsByTaskKey[key] = typeof row.body === "string" ? row.body : "";
    });

    // Archived tasks also carry body directly (migration 0005) – prefer it over
    // any legacy description lookup so archived descriptions survive cross-device sync.
    payloadArchivedTasks.forEach((row) => {
      if (!row || typeof row.project_id !== "string" || typeof row.id !== "string") return;
      const key = row.project_id + "::" + row.id;
      if (typeof row.body === "string") descriptionsByTaskKey[key] = row.body;
    });

    payloadDescriptions.forEach((row) => {
      if (!row || typeof row.project_id !== "string" || typeof row.task_id !== "string") return;
      const key = row.project_id + "::" + row.task_id;
      descriptionsByTaskKey[key] = typeof row.body === "string" ? row.body : "";
    });

    payloadTasks.forEach((row) => {
      if (!row || typeof row.project_id !== "string" || typeof row.id !== "string") return;
      const projectId = row.project_id;
      if (!projectsById[projectId]) {
        projectsById[projectId] = createEmptyProjectState(projectId, "");
      }
      const record = normalizeTaskRecord({
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        description: typeof row.body === "string" ? row.body : "",
        dueDate: row.due_date,
        source: row.source,
        generatedKey: row.generated_key,
        pinned: row.pinned,
        endOfDay: row.end_of_day,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }, projectId, false);
      if (!record || !record.name) return;
      projectsById[projectId].tasks[row.id] = record;
      projectsById[projectId].updatedAt = laterIso(projectsById[projectId].updatedAt, record.updatedAt);
      nextState.updatedAt = laterIso(nextState.updatedAt, record.updatedAt);
    });

    payloadArchivedTasks.forEach((row) => {
      if (!row || typeof row.project_id !== "string" || typeof row.id !== "string") return;
      const projectId = row.project_id;
      if (!projectsById[projectId]) {
        projectsById[projectId] = createEmptyProjectState(projectId, "");
      }
      const record = normalizeTaskRecord({
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        description: descriptionsByTaskKey[projectId + "::" + row.id] || "",
        dueDate: row.due_date,
        source: row.source,
        generatedKey: row.generated_key,
        pinned: row.pinned,
        endOfDay: row.end_of_day,
        completedAt: row.completed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }, projectId, true);
      if (!record || !record.name) return;
      projectsById[projectId].archived[row.id] = record;
      projectsById[projectId].updatedAt = laterIso(projectsById[projectId].updatedAt, record.updatedAt);
      nextState.updatedAt = laterIso(nextState.updatedAt, record.updatedAt);
    });

    payloadGeneratedOccurrences.forEach((row) => {
      if (!row || typeof row.project_id !== "string" || typeof row.occurrence_key !== "string") return;
      const projectId = row.project_id;
      if (!projectsById[projectId]) {
        projectsById[projectId] = createEmptyProjectState(projectId, "");
      }
      const createdAt = typeof row.created_at === "string" ? row.created_at : nowIso();
      projectsById[projectId].generatedOccurrences[row.occurrence_key] = {
        createdAt,
        taskId: typeof row.task_id === "string" && row.task_id ? row.task_id : null,
        dueDate: isDateKey(row.due_date) ? row.due_date : null,
        taskName: typeof row.task_name === "string" ? row.task_name : "",
      };
      nextState.updatedAt = laterIso(nextState.updatedAt, createdAt);
    });

    nextState.projects = projectsById;
    return normalizeState(nextState);
  }

  async function fetchNormalizedRemoteState() {
    if (!supabase || !currentUser) return null;
    const userId = currentUser.id;

    const [
      userSettingsRes,
      projectsRes,
      tasksRes,
      archivedTasksRes,
      generatedOccurrencesRes,
      tagsRes,
      projectTagsRes,
    ] = await Promise.all([
      supabase
        .schema("todo")
        .from(USER_SETTINGS_TABLE)
        .select("default_project_id, default_project_updated_at, updated_at")
        .eq("user_id", userId)
        .maybeSingle(),
      supabase.schema("todo").from(PROJECTS_TABLE).select("id, name, inactive, last_generated_through, updated_at").eq("user_id", userId),
      supabase.schema("todo").from(TASKS_TABLE).select("id, project_id, name, due_date, source, generated_key, pinned, end_of_day, body, created_at, updated_at").eq("user_id", userId),
      supabase.schema("todo").from(ARCHIVED_TASKS_TABLE).select("id, project_id, name, due_date, source, generated_key, pinned, end_of_day, body, completed_at, created_at, updated_at").eq("user_id", userId),
      supabase.schema("todo").from(GENERATED_OCCURRENCES_TABLE).select("occurrence_key, project_id, task_id, due_date, task_name, created_at").eq("user_id", userId),
      supabase.schema("todo").from(TAGS_TABLE).select("tag").eq("user_id", userId),
      supabase.schema("todo").from(PROJECT_TAGS_TABLE).select("project_id, tag").eq("user_id", userId),
    ]);

    const firstError = [
      userSettingsRes.error,
      projectsRes.error,
      tasksRes.error,
      archivedTasksRes.error,
      generatedOccurrencesRes.error,
      tagsRes.error,
      projectTagsRes.error,
    ].find(Boolean);

    if (firstError) {
      throw firstError;
    }

    return buildStateFromNormalizedRows({
      userSettings: userSettingsRes.data,
      projects: projectsRes.data,
      tasks: tasksRes.data,
      archivedTasks: archivedTasksRes.data,
      generatedOccurrences: generatedOccurrencesRes.data,
      descriptions: [],
      tags: tagsRes.data || [],
      projectTags: projectTagsRes.data || [],
    });
  }

  async function pullState() {
    if (!supabase || !currentUser) return false;

    try {
      const remoteState = await fetchNormalizedRemoteState();
      if (!remoteState) return false;
      // Server is the source of truth: always use server state directly.
      appState = normalizeState(remoteState);
      appMode = "online";
      lastPullErrorMessage = "";
      saveStateLocal();
      lastPullAt = Date.now();
      return true;
    } catch (error) {
      console.error("Sync pull error:", error.message || error);
      lastPullErrorMessage = getErrorMessage(error);
      if (isServerConnectionError(error)) appMode = "offline-readonly";
      showServerConnectionIssue(error, "sync-pull");
      return false;
    }
  }

  async function syncNow() {
    if (!currentUser) return;
    if (!hasNetworkConnection()) {
      appMode = "offline-readonly";
      updateOfflineBanner();
      setSyncStatus("Offline — showing cached data in read-only mode.");
      return;
    }
    setSyncStatus("Refreshing from server...");
    const pulled = await pullState();
    if (pulled) {
      await fetchAllProjectConfigsFromDb();
      await fetchAllRecurringTaskDescriptionsFromDb();
      rebuildProjectConfigs();
      await generateTasksForProjectsOnServer(Object.keys(projectConfigs));
    }
    renderCurrentScreen();
    if (pulled) {
      setSyncStatus("Refreshed from server.");
    } else if (isOfflineModeExpected()) {
      setSyncStatus("Offline — showing cached data in read-only mode.");
    } else {
      setSyncStatus("Could not refresh from server.");
    }
  }

  function getVisibleProjectsForState(state, options) {
    const normalized = normalizeState(state);
    const selectedTags = options && options.selectedTags instanceof Set ? options.selectedTags : selectedProjectTagFilters;
    const applyTagFilter = !(options && options.applyTagFilter === false);
    return Object.keys(normalized.projects)
      .map((projectId) => {
        const projectState = normalized.projects[projectId];
        return {
          id: projectId,
          name: projectState && projectState.name ? projectState.name : projectId,
          tags: normalizeTagList(projectState && projectState.tags),
          inactive: !!(projectState && projectState.inactive),
        };
      })
      .filter((project) => project.name && !project.inactive)
      .filter((project) => {
        if (!applyTagFilter || !selectedTags || selectedTags.size === 0) return true;
        return project.tags.some((tag) => selectedTags.has(tag));
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // --- Task description API (merged into tasks table) ---

  async function fetchTaskDescription(projectId, taskId) {
    if (!supabase || !currentUser || !projectId || !taskId) return null;
    try {
      const { data, error } = await supabase
        .schema("todo")
        .from(TASKS_TABLE)
        .select("body")
        .eq("project_id", projectId)
        .eq("id", taskId)
        .eq("user_id", currentUser.id)
        .maybeSingle();
      if (error) {
        console.warn("Failed to fetch task description:", error.message);
        showServerConnectionIssue(error, "task-description-fetch");
        return null;
      }
      return data ? data.body : null;
    } catch (error) {
      console.warn("Failed to fetch task description:", error);
      showServerConnectionIssue(error, "task-description-fetch");
      return null;
    }
  }

  // --------------------------------------------------------

  function createId(prefix) {
    return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  function createStableId(prefix, input) {
    return window.TaskPlannerCore.createStableId(prefix, input);
  }

  function parseProjectConfig(text) {
    return window.TaskPlannerCore.parseProjectConfig(text);
  }

  function getWeekdayToken(dateKey) {
    return WEEKDAY_TOKENS[parseDateKey(dateKey).getDay()];
  }

  function ruleMatchesDate(rule, dateKey) {
    return window.TaskPlannerCore.ruleMatchesDate(rule, dateKey);
  }

  // --- Project config local cache ---

  function loadLocalProjectConfigs() {
    const storageKey = getUserStorageKey(PROJECT_CONFIGS_STORAGE_KEY);
    if (!storageKey) {
      projectConfigTexts = {};
      return false;
    }
    try {
      const raw = localStorage.getItem(storageKey);
      projectConfigTexts = raw ? JSON.parse(raw) : {};
      if (typeof projectConfigTexts !== "object" || Array.isArray(projectConfigTexts)) {
        projectConfigTexts = {};
      }
      return !!raw;
    } catch (error) {
      console.warn("Failed to load local project configs:", error);
      projectConfigTexts = {};
      return false;
    }
  }

  function saveLocalProjectConfigs() {
    const storageKey = getUserStorageKey(PROJECT_CONFIGS_STORAGE_KEY);
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(projectConfigTexts));
    } catch (error) {
      console.warn("Failed to save local project configs:", error);
    }
  }

  function rebuildProjectConfigs() {
    projectConfigs = {};
    Object.keys(projectConfigTexts).forEach((projectId) => {
      const text = projectConfigTexts[projectId];
      if (text && typeof text === "string") {
        projectConfigs[projectId] = parseProjectConfig(text);
      }
    });
  }

  // --- Project config Supabase API ---

  async function fetchAllProjectConfigsFromDb() {
    if (!supabase || !currentUser) return;
    try {
      const { data, error } = await supabase
        .schema("todo")
        .from(PROJECTS_TABLE)
        .select("id, config_text")
        .eq("user_id", currentUser.id);
      if (error) {
        console.warn("Failed to fetch project configs:", error.message);
        showServerConnectionIssue(error, "project-config-fetch");
        return;
      }
      if (Array.isArray(data)) {
        data.forEach((row) => {
          if (row.id && typeof row.config_text === "string") {
            projectConfigTexts[row.id] = row.config_text;
          }
        });
        saveLocalProjectConfigs();
        rebuildProjectConfigs();
      }
    } catch (error) {
      console.warn("Failed to fetch project configs:", error);
      showServerConnectionIssue(error, "project-config-fetch");
    }
  }

  async function upsertProjectConfigToDb(projectId, configText) {
    if (!supabase || !currentUser) return;
    try {
      const { error } = await supabase
        .schema("todo")
        .from(PROJECTS_TABLE)
        .update({ config_text: configText })
        .eq("user_id", currentUser.id)
        .eq("id", projectId);
      if (error) {
        console.warn("Failed to save project config:", error.message);
        showServerConnectionIssue(error, "project-config-upsert");
      }
    } catch (error) {
      console.warn("Failed to save project config:", error);
      showServerConnectionIssue(error, "project-config-upsert");
    }
  }

  async function deleteProjectConfigFromDb(projectId) {
    if (!supabase || !currentUser) return;
    try {
      const { error } = await supabase
        .schema("todo")
        .from(PROJECTS_TABLE)
        .update({ config_text: "" })
        .eq("user_id", currentUser.id)
        .eq("id", projectId);
      if (error) {
        console.warn("Failed to delete project config:", error.message);
        showServerConnectionIssue(error, "project-config-delete");
      }
    } catch (error) {
      console.warn("Failed to delete project config:", error);
      showServerConnectionIssue(error, "project-config-delete");
    }
  }

  // --- Recurring task descriptions local cache ---
  // Maps projectId → { taskName → description }. Stored in localStorage for
  // offline use and synced with the `todo.recurring_task_descriptions` table.

  function loadLocalRecurringTaskDescriptions() {
    const storageKey = getUserStorageKey(RECURRING_TASK_DESCRIPTIONS_STORAGE_KEY);
    if (!storageKey) {
      recurringTaskDescriptions = {};
      return false;
    }
    try {
      const raw = localStorage.getItem(storageKey);
      recurringTaskDescriptions = raw ? JSON.parse(raw) : {};
      if (typeof recurringTaskDescriptions !== "object" || Array.isArray(recurringTaskDescriptions)) {
        recurringTaskDescriptions = {};
      }
      return !!raw;
    } catch (error) {
      console.warn("Failed to load local recurring task descriptions:", error);
      recurringTaskDescriptions = {};
      return false;
    }
  }

  function saveLocalRecurringTaskDescriptions() {
    const storageKey = getUserStorageKey(RECURRING_TASK_DESCRIPTIONS_STORAGE_KEY);
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(recurringTaskDescriptions));
    } catch (error) {
      console.warn("Failed to save local recurring task descriptions:", error);
    }
  }

  /**
   * Returns the project-scoped default description for the given recurring task
   * name, or an empty string if none is configured. Matching is exact (case-
   * sensitive) against the task name as it appears in the recurring config.
   */
  function getRecurringTaskDefaultDescription(projectId, taskName) {
    const projectDescs = recurringTaskDescriptions[projectId];
    if (!projectDescs || typeof projectDescs !== "object") return "";
    return typeof projectDescs[taskName] === "string" ? projectDescs[taskName] : "";
  }

  // --- Recurring task descriptions Supabase API ---

  async function fetchAllRecurringTaskDescriptionsFromDb() {
    if (!supabase || !currentUser) return;
    try {
      const { data, error } = await supabase
        .schema("todo")
        .from(RECURRING_TASK_DESCRIPTIONS_TABLE)
        .select("project_id, task_name, description")
        .eq("user_id", currentUser.id);
      if (error) {
        console.warn("Failed to fetch recurring task descriptions:", error.message);
        showServerConnectionIssue(error, "recurring-task-desc-fetch");
        return;
      }
      if (Array.isArray(data)) {
        // Rebuild from remote data (remote is authoritative after a fetch).
        recurringTaskDescriptions = {};
        data.forEach((row) => {
          if (row.project_id && typeof row.task_name === "string" && row.task_name) {
            if (!recurringTaskDescriptions[row.project_id]) {
              recurringTaskDescriptions[row.project_id] = {};
            }
            recurringTaskDescriptions[row.project_id][row.task_name] = typeof row.description === "string" ? row.description : "";
          }
        });
        saveLocalRecurringTaskDescriptions();
      }
    } catch (error) {
      console.warn("Failed to fetch recurring task descriptions:", error);
      showServerConnectionIssue(error, "recurring-task-desc-fetch");
    }
  }

  async function upsertRecurringTaskDescriptionToDb(projectId, taskName, description) {
    if (!supabase || !currentUser || !projectId || !taskName) return;
    try {
      const { error } = await supabase
        .schema("todo")
        .from(RECURRING_TASK_DESCRIPTIONS_TABLE)
        .upsert(
          {
            user_id: currentUser.id,
            project_id: projectId,
            task_name: taskName,
            description: description || "",
          },
          { onConflict: "user_id, project_id, task_name" }
        );
      if (error) {
        console.warn("Failed to save recurring task description:", error.message);
        showServerConnectionIssue(error, "recurring-task-desc-upsert");
      }
    } catch (error) {
      console.warn("Failed to save recurring task description:", error);
      showServerConnectionIssue(error, "recurring-task-desc-upsert");
    }
  }

  async function deleteRecurringTaskDescriptionFromDb(projectId, taskName) {
    if (!supabase || !currentUser || !projectId || !taskName) return;
    try {
      const { error } = await supabase
        .schema("todo")
        .from(RECURRING_TASK_DESCRIPTIONS_TABLE)
        .delete()
        .eq("user_id", currentUser.id)
        .eq("project_id", projectId)
        .eq("task_name", taskName);
      if (error) {
        console.warn("Failed to delete recurring task description:", error.message);
        showServerConnectionIssue(error, "recurring-task-desc-delete");
      }
    } catch (error) {
      console.warn("Failed to delete recurring task description:", error);
      showServerConnectionIssue(error, "recurring-task-desc-delete");
    }
  }

  function getAllProjects() {
    return getVisibleProjectsForState(appState, { applyTagFilter: false })
      .map((project) => ({
        id: project.id,
        name: project.name,
        tags: normalizeTagList(project.tags),
        hasConfig: !!(projectConfigs[project.id] && projectConfigs[project.id].length > 0),
      }));
  }

  function getInactiveProjects() {
    return Object.keys(appState.projects)
      .map((projectId) => {
        const projectState = appState.projects[projectId];
        return {
          id: projectId,
          name: projectState && projectState.name ? projectState.name : projectId,
          hasConfig: !!(projectConfigs[projectId] && projectConfigs[projectId].length > 0),
          inactive: !!(projectState && projectState.inactive),
        };
      })
      .filter((project) => project.name && project.inactive)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function getProjectMeta(projectId) {
    const projectState = appState.projects[projectId];
    if (!projectState || !projectState.name) return null;

    return {
      id: projectId,
      name: projectState.name,
      tags: normalizeTagList(projectState.tags),
      hasConfig: !!(projectConfigs[projectId] && projectConfigs[projectId].length > 0),
    };
  }

  function buildProjectId(name) {
    const slug = String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "project";
    let candidate = "project-" + slug;
    let suffix = 2;

    while (getProjectMeta(candidate) || appState.projects[candidate]) {
      candidate = "project-" + slug + "-" + suffix;
      suffix += 1;
    }

    return candidate;
  }

  function ensureProjectState(projectId, projectName) {
    if (!appState.projects[projectId]) {
      appState.projects[projectId] = createEmptyProjectState(projectId, projectName);
    }

    const projectState = appState.projects[projectId];
    if (projectName) {
      projectState.name = projectName;
    }
    return projectState;
  }

  function buildRecurringGenerationRequest(projectId) {
    const rules = projectConfigs[projectId];
    const projectState = appState.projects[projectId];
    if (!rules || !rules.length || !projectState || projectState.inactive) return null;

    const horizonStart = todayKey();
    const horizonEnd = addDays(horizonStart, 6);
    const rangeStart = projectState.lastGeneratedThrough && compareDateKeys(projectState.lastGeneratedThrough, horizonStart) < 0
      ? addDays(projectState.lastGeneratedThrough, 1)
      : horizonStart;
    const candidates = [];

    enumerateDateKeys(rangeStart, horizonEnd).forEach((dateKey) => {
      rules.forEach((rule) => {
        if (!ruleMatchesDate(rule, dateKey)) return;
        const generatedKey = projectId + "|" + rule.signature + "|" + dateKey;
        if (projectState.generatedOccurrences[generatedKey]) return;
        candidates.push({
          id: createStableId("task", generatedKey),
          name: rule.name,
          body: getRecurringTaskDefaultDescription(projectId, rule.name),
          due_date: dateKey,
          generated_key: generatedKey,
        });
      });
    });

    return {
      projectId,
      generatedThrough: horizonEnd,
      candidates,
      changed: candidates.length > 0 || projectState.lastGeneratedThrough !== horizonEnd,
    };
  }

  async function submitGenerationRequests(requests) {
    for (const request of requests) {
      const result = await supabase.schema("todo").rpc("generate_recurring_tasks", {
        p_project_id: request.projectId,
        p_generated_through: request.generatedThrough,
        p_candidates: request.candidates,
      });
      if (result.error) return result;
    }
    return { error: null };
  }

  async function generateTasksForProjectsOnServer(projectIds) {
    const requests = projectIds
      .map(buildRecurringGenerationRequest)
      .filter((request) => request && request.changed);
    if (!requests.length) {
      setSyncStatus("No new tasks were needed.");
      return true;
    }
    return runServerCommand("Generating recurring tasks on server...", () => submitGenerationRequests(requests));
  }

  function getProjectState(projectId) {
    return appState.projects[projectId] || createEmptyProjectState(projectId, "");
  }

  function getProjectTasks(projectId) {
    return Object.values(getProjectState(projectId).tasks || {});
  }

  function getProjectArchivedTasks(projectId) {
    return Object.values(getProjectState(projectId).archived || {});
  }

  function sortActiveTasks(tasks) {
    return tasks.slice().sort((a, b) => {
      const catA = a.pinned ? 0 : (a.endOfDay ? 2 : 1);
      const catB = b.pinned ? 0 : (b.endOfDay ? 2 : 1);
      if (catA !== catB) return catA - catB;
      const dueA = a.dueDate || "9999-12-31";
      const dueB = b.dueDate || "9999-12-31";
      if (dueA !== dueB) return compareDateKeys(dueA, dueB);
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return compareIso(a.createdAt, b.createdAt);
    });
  }

  function sortArchivedTasks(tasks) {
    return tasks.slice().sort((a, b) => {
      const completedCompare = compareIso(b.completedAt, a.completedAt);
      if (completedCompare !== 0) return completedCompare;
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return compareIso(b.createdAt, a.createdAt);
    });
  }

  function getVisibleDates() {
    const start = todayKey();
    return enumerateDateKeys(start, addDays(start, 6));
  }

  function getDeferDates(excludeDateKey) {
    const start = todayKey();
    const dates = enumerateDateKeys(start, addDays(start, 7));
    if (!excludeDateKey) return dates;
    return dates.filter((d) => d !== excludeDateKey);
  }

  function formatDateLong(dateKey) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    }).format(parseDateKey(dateKey));
  }

  function formatDateShort(dateKey) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(parseDateKey(dateKey));
  }

  function formatDatePill(dateKey) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(parseDateKey(dateKey));
  }

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function formatDayCardHeader(dateKey) {
    const d = parseDateKey(dateKey);
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(d);
    const month = new Intl.DateTimeFormat(undefined, { month: "long" }).format(d);
    return weekday + " " + ordinal(d.getDate()) + " " + month;
  }

  // Converts a YYYY-MM-DD dateKey to a DD/MM/YYYY display string.
  function formatDateDisplay(dateKey) {
    if (!dateKey) return "";
    const parts = dateKey.split("-");
    if (parts.length !== 3) return dateKey;
    return parts[2] + "/" + parts[1] + "/" + parts[0];
  }

  function isTaskVisibleInCurrentView(dueDate) {
    if (selectedTaskView === "all") return true;
    if (selectedTaskView === "day") return dueDate === selectedDate;
    if (selectedTaskView === "nodate") return !dueDate;
    const today = todayKey();
    if (selectedTaskView === "overdue") {
      return !!dueDate && compareDateKeys(dueDate, today) < 0;
    }
    if (selectedTaskView === "future") {
      return !!dueDate && compareDateKeys(dueDate, addDays(today, 6)) > 0;
    }
    return false;
  }

  let toastTimer = null;
  let modalReturnFocus = null;

  function showToast(message) {
    let toast = document.getElementById("app-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "app-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.remove("app-toast-hide");
    toast.classList.add("app-toast-show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove("app-toast-show");
      toast.classList.add("app-toast-hide");
      toastTimer = null;
    }, TOAST_DISPLAY_MS);
  }

  function getModalFocusableElements(modal) {
    return Array.from(modal.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((element) => !element.closest(".hidden"));
  }

  function openModal(modalId, initialFocusSelector) {
    const modal = $("#" + modalId);
    if (!modal) return;
    modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    const initialFocus = initialFocusSelector ? modal.querySelector(initialFocusSelector) : null;
    const focusTarget = initialFocus || getModalFocusableElements(modal)[0];
    if (focusTarget) requestAnimationFrame(() => focusTarget.focus());
  }

  function closeModal(modalId) {
    const modal = $("#" + modalId);
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    if (modalReturnFocus && document.contains(modalReturnFocus)) {
      modalReturnFocus.focus();
    }
    modalReturnFocus = null;
  }

  function handleModalKeydown(event) {
    const modal = document.querySelector(".modal:not(.hidden)");
    if (!modal) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (modal.id === "config-modal") closeConfigModal();
      else if (modal.id === "add-task-modal") closeAddTaskModal();
      else if (modal.id === "edit-modal") closeEditModal();
      else if (modal.id === "defer-modal") closeDeferModal();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = getModalFocusableElements(modal);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function hasNetworkConnection() {
    return typeof navigator !== "undefined" ? navigator.onLine !== false : true;
  }

  function isOnline() {
    return appMode === "online";
  }

  function isOfflineModeExpected() {
    if (!currentUser || !supabase) return true;
    return appMode !== "online";
  }

  /**
   * Guards mutating operations when offline.
   * Returns true if the app is currently offline (caller should abort).
   */
  function guardOffline() {
    if (appMode !== "online") {
      showToast("You are offline. Edits are unavailable until you reconnect.");
      return true;
    }
    if (serverCommandInFlight) {
      showToast("Please wait for the current server update to finish.");
      return true;
    }
    return false;
  }

  async function runServerCommand(statusMessage, command) {
    if (guardOffline() || !currentUser || !supabase) return false;
    serverCommandInFlight = true;
    setSyncStatus(statusMessage);
    updateMutationButtonsForOffline();

    try {
      const result = await command();
      if (result && result.error) throw result.error;

      const pulled = await pullState();
      if (!pulled) throw new Error("The server update completed, but the refreshed state could not be loaded.");
      await fetchAllProjectConfigsFromDb();
      await fetchAllRecurringTaskDescriptionsFromDb();
      rebuildProjectConfigs();
      renderCurrentScreen();
      setSyncStatus("Saved to server.");
      return true;
    } catch (error) {
      console.error("Server command failed:", error);
      const connectionIssue = isServerConnectionError(error);
      showServerConnectionIssue(error, "server-command");
      if (appMode === "online") {
        setSyncStatus("Server update failed. No local change was saved.");
        const detail = connectionIssue ? "" : getUserFacingServerError(error);
        showToast(detail ? `Server update failed: ${detail}` : "Server update failed. No changes were made.");
      }
      renderCurrentScreen();
      return false;
    } finally {
      serverCommandInFlight = false;
      updateMutationButtonsForOffline();
    }
  }

  function updateOfflineBanner() {
    const banner = $("#offline-banner");
    if (!banner) return;
    if (appMode === "offline-readonly") {
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  function getErrorMessage(error) {
    if (!error) return "";
    if (typeof error === "string") return error;
    if (typeof error.message === "string") return error.message;
    return String(error);
  }

  function getUserFacingServerError(error) {
    const message = getErrorMessage(error)
      .replace(/\s+/g, " ")
      .trim();
    if (!message) return "";
    if (message.length <= 180) return message;
    return message.slice(0, 177) + "...";
  }

  function isServerConnectionError(error) {
    const message = getErrorMessage(error).toLowerCase();
    if (!message) return false;
    return (
      message.indexOf("failed to fetch") >= 0 ||
      message.indexOf("fetch failed") >= 0 ||
      message.indexOf("networkerror") >= 0 ||
      message.indexOf("network request failed") >= 0 ||
      message.indexOf("load failed") >= 0 ||
      message.indexOf("connection") >= 0 ||
      message.indexOf("timeout") >= 0 ||
      message.indexOf("abort") >= 0
    );
  }

  function showServerConnectionIssue(error, source) {
    if (!isServerConnectionError(error)) return;

    appMode = "offline-readonly";
    updateOfflineBanner();
    setSyncStatus("Could not reach the server. Showing cached data in read-only mode.");

    const now = Date.now();
    if (now - lastServerErrorToastAt >= SERVER_ERROR_TOAST_COOLDOWN_MS) {
      showToast("Could not connect to the server. Cached data is read-only.");
      lastServerErrorToastAt = now;
    }

    if (source) {
      console.warn("Server connection issue (" + source + "):", getErrorMessage(error));
    }
  }

  function formatTimestamp(timestamp) {
    if (!timestamp) return "";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timestamp));
  }

  function buildProjectStats(projectId) {
    const activeTasks = getProjectTasks(projectId);
    const archivedTasks = getProjectArchivedTasks(projectId);
    const today = todayKey();
    return {
      active: activeTasks.length,
      dueToday: activeTasks.filter((task) => task.dueDate === today).length,
      overdue: activeTasks.filter((task) => task.dueDate && compareDateKeys(task.dueDate, today) < 0).length,
      noDueDate: activeTasks.filter((task) => !task.dueDate).length,
      archived: archivedTasks.length,
    };
  }

  function getDayStats(projectId, dateKey) {
    const activeTasks = getProjectTasks(projectId).filter((task) => task.dueDate === dateKey);
    const archivedTasks = getProjectArchivedTasks(projectId).filter((task) => task.dueDate === dateKey);
    const taskCategoryCounts = getIncompleteTaskCategoryCounts(activeTasks);
    return {
      required: activeTasks.length + archivedTasks.length,
      complete: archivedTasks.length,
      incomplete: activeTasks.length,
      pinned: taskCategoryCounts.pinned,
      endOfDay: taskCategoryCounts.endOfDay,
    };
  }

  function getIncompleteTaskCategoryCounts(tasks) {
    return tasks.reduce((counts, task) => {
      if (task.pinned) counts.pinned += 1;
      if (task.endOfDay) counts.endOfDay += 1;
      return counts;
    }, { pinned: 0, endOfDay: 0 });
  }

  function formatIncompleteTaskBreakdown(taskCount, pinnedCount, endOfDayCount) {
    if (!taskCount) return "";
    const parts = [];
    if (pinnedCount) parts.push(`${pinnedCount} pinned`);
    if (endOfDayCount) parts.push(`${endOfDayCount} end of day`);
    return parts.length ? ` (${parts.join(", ")})` : "";
  }

  function setSyncStatus(message) {
    const status = $("#sync-status");
    if (!status) return;
    status.textContent = message;
  }

  function showScreen(name) {
    const splashEl = $("#splash-screen");

    if (splashEl && splashEl.classList.contains("active") && name !== "splash") {
      // Activate the target screen behind the splash, then fade splash out
      $("#auth-screen").classList.toggle("active", name === "auth");
      $("#home-screen").classList.toggle("active", name === "home");
      $("#project-screen").classList.toggle("active", name === "project");
      $("#day-screen").classList.toggle("active", name === "day");
      $("#archive-screen").classList.toggle("active", name === "archive");
      $("#inactive-screen").classList.toggle("active", name === "inactive");
      splashEl.classList.add("splash-hiding");
      setTimeout(() => splashEl.classList.remove("active", "splash-hiding"), 480);
      return;
    }

    if (splashEl) splashEl.classList.toggle("active", name === "splash");
    $("#auth-screen").classList.toggle("active", name === "auth");
    $("#home-screen").classList.toggle("active", name === "home");
    $("#project-screen").classList.toggle("active", name === "project");
    $("#day-screen").classList.toggle("active", name === "day");
    $("#archive-screen").classList.toggle("active", name === "archive");
    $("#inactive-screen").classList.toggle("active", name === "inactive");
  }

  function showUserBar() {
    if (currentUser) {
      $("#user-email").textContent = currentUser.email;
      $("#user-bar").classList.remove("hidden");
      if (!isOnline()) {
        setSyncStatus("Offline — read-only mode. Reconnect to make changes.");
      } else {
        setSyncStatus("Connected. Data is loaded from the server.");
      }
      return;
    }

    $("#user-bar").classList.add("hidden");
    setSyncStatus(supabase ? "Sign in to load your tasks." : "Supabase configuration is required.");
  }

  function createChip(text, strongText) {
    const chip = document.createElement("span");
    chip.className = "chip";
    if (strongText) {
      const strong = document.createElement("strong");
      strong.textContent = strongText;
      chip.appendChild(strong);
      chip.appendChild(document.createTextNode(" " + text));
      return chip;
    }
    chip.textContent = text;
    return chip;
  }

  function renderHomeSummary(projects) {
    const summaryEl = $("#home-summary");
    if (!summaryEl) return;
    summaryEl.innerHTML = "";

    if (!projects.length) return;

    const projectsWithStats = projects.map((p) => ({ project: p, stats: buildProjectStats(p.id) }))
      .filter(({ stats }) => stats.overdue > 0 || stats.dueToday > 0);

    const totalOverdue = projectsWithStats.reduce((sum, { stats }) => sum + stats.overdue, 0);
    const totalDueToday = projectsWithStats.reduce((sum, { stats }) => sum + stats.dueToday, 0);

    const box = document.createElement("div");
    box.className = "home-summary-box";

    if (totalOverdue === 0 && totalDueToday === 0) {
      const msg = document.createElement("p");
      msg.className = "home-summary-empty";
      msg.textContent = "No tasks overdue or due today";
      box.appendChild(msg);
    } else {
      const header = document.createElement("div");
      header.className = "home-summary-header";
      const titleEl = document.createElement("span");
      titleEl.className = "home-summary-title";
      titleEl.textContent = "Tasks Overdue & Due Today";
      header.appendChild(titleEl);
      const chips = document.createElement("span");
      chips.className = "home-summary-chips";
      if (totalOverdue > 0) chips.appendChild(createChip("overdue", String(totalOverdue)));
      if (totalDueToday > 0) chips.appendChild(createChip("due today", String(totalDueToday)));
      header.appendChild(chips);
      box.appendChild(header);

      const table = document.createElement("table");
      table.className = "home-summary-table";

      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      ["Project", "Overdue", "Due Today"].forEach((label) => {
        const th = document.createElement("th");
        th.textContent = label;
        headerRow.appendChild(th);
      });
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      projectsWithStats.forEach(({ project, stats }) => {
        const row = document.createElement("tr");

        const nameCell = document.createElement("td");
        const nameBtn = document.createElement("button");
        nameBtn.className = "home-summary-link home-summary-cell-button";
        nameBtn.textContent = project.name;
        nameBtn.addEventListener("click", () => openProject(project.id));
        nameCell.appendChild(nameBtn);
        row.appendChild(nameCell);

        const overdueCell = document.createElement("td");
        const overdueBtn = document.createElement("button");
        overdueBtn.className = "home-summary-link home-summary-cell-button";
        if (stats.overdue > 0) overdueBtn.classList.add("home-summary-overdue");
        else overdueBtn.classList.add("home-summary-zero");
        overdueBtn.textContent = String(stats.overdue);
        overdueBtn.addEventListener("click", () => {
          currentProjectId = project.id;
          openOverdue();
        });
        overdueCell.appendChild(overdueBtn);
        row.appendChild(overdueCell);

        const dueTodayCell = document.createElement("td");
        const dueTodayBtn = document.createElement("button");
        dueTodayBtn.className = "home-summary-link home-summary-cell-button";
        if (stats.dueToday > 0) dueTodayBtn.classList.add("home-summary-due-today");
        else dueTodayBtn.classList.add("home-summary-zero");
        dueTodayBtn.textContent = String(stats.dueToday);
        dueTodayBtn.addEventListener("click", () => {
          currentProjectId = project.id;
          openDay(todayKey());
        });
        dueTodayCell.appendChild(dueTodayBtn);
        row.appendChild(dueTodayCell);

        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      box.appendChild(table);
    }

    summaryEl.appendChild(box);
  }

  function renderHome() {
    closeCreateProjectPanel();
    const projectGrid = $("#project-grid");
    const emptyState = $("#home-empty");
    projectGrid.innerHTML = "";
    const offline = !isOnline();
    const allVisibleProjects = getAllProjects();
    renderHomeTagFilters(allVisibleProjects);
    const projects = getTagFilteredProjects(allVisibleProjects, selectedProjectTagFilters);
    const toggleProjectActionsBtn = $("#toggle-project-actions-btn");
    if (toggleProjectActionsBtn) {
      toggleProjectActionsBtn.textContent = showProjectActions ? "Hide Project Actions" : "Show Project Actions";
      toggleProjectActionsBtn.setAttribute("aria-expanded", showProjectActions ? "true" : "false");
    }

    const deleteAllArchivesBtn = $("#delete-all-archives-btn");
    if (deleteAllArchivesBtn) {
      deleteAllArchivesBtn.disabled = true;
      deleteAllArchivesBtn.classList.toggle("hidden", !showProjectActions);
    }

    const generateAllBtn = $("#generate-all-btn");
    if (generateAllBtn) {
      generateAllBtn.classList.toggle("hidden", !showProjectActions);
      generateAllBtn.disabled = offline;
    }

    const createProjectBtn = $("#open-create-project-btn");
    if (createProjectBtn) {
      createProjectBtn.classList.toggle("hidden", !showProjectActions);
      createProjectBtn.disabled = offline;
    }

    const downloadAllArchivesBtn = $("#download-all-archives-btn");
    if (downloadAllArchivesBtn) {
      downloadAllArchivesBtn.classList.toggle("hidden", !showProjectActions);
    }

    const homeAddTaskBtn = $("#open-home-add-task-btn");
    if (homeAddTaskBtn) {
      homeAddTaskBtn.classList.toggle("hidden", !showProjectActions || projects.length === 0);
      homeAddTaskBtn.disabled = offline;
    }

    renderHomeSummary(projects);

    if (!projects.length) {
      emptyState.classList.remove("hidden");
      const viewInactiveBtn = $("#view-inactive-btn");
      if (viewInactiveBtn) {
        viewInactiveBtn.classList.toggle("hidden", !showProjectActions || getInactiveProjects().length === 0);
      }
      return;
    }

    emptyState.classList.add("hidden");

    projects.forEach((project) => {
      const stats = buildProjectStats(project.id);
      const projectState = ensureProjectState(project.id, project.name);
      const projectTags = normalizeTagList(projectState.tags);
      const isDefault = appState.defaultProjectId === project.id;
      const card = document.createElement("div");
      card.className = "project-card" + (isDefault ? " project-card-default" : "");
      card.addEventListener("click", () => {
        openProject(project.id);
      });

      const topRow = document.createElement("div");
      topRow.className = "project-card-top";

      const title = document.createElement("div");
      title.className = "project-card-title";
      title.textContent = project.name;
      topRow.appendChild(title);

      const topRowActions = document.createElement("div");
      topRowActions.className = "project-card-top-actions";
      topRowActions.appendChild(createChip("active", String(stats.active)));

      const defaultButton = document.createElement("button");
      defaultButton.type = "button";
      defaultButton.className = isDefault ? "project-card-default-btn project-card-default-btn-active" : "project-card-default-btn";
      defaultButton.textContent = isDefault ? "★ Default" : "☆ Set default";
      defaultButton.title = isDefault ? "This is your default project. Click to clear." : "Open this project's today view on app start.";
      defaultButton.disabled = offline;
      defaultButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (isDefault) {
          clearDefaultProject();
        } else {
          setDefaultProject(project.id);
        }
      });
      topRowActions.appendChild(defaultButton);

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "project-card-delete";
      deleteButton.textContent = "Delete";
      deleteButton.disabled = offline;
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteProject(project.id);
      });
      topRowActions.appendChild(deleteButton);

      const tagsButton = document.createElement("button");
      tagsButton.type = "button";
      tagsButton.className = "project-card-tags";
      tagsButton.textContent = "Tags";
      tagsButton.title = "Edit project tags";
      tagsButton.disabled = offline;
      tagsButton.addEventListener("click", (event) => {
        event.stopPropagation();
        promptEditProjectTags(project.id);
      });
      topRowActions.appendChild(tagsButton);

      const inactiveButton = document.createElement("button");
      inactiveButton.type = "button";
      inactiveButton.className = "project-card-inactive";
      inactiveButton.textContent = "Make inactive";
      inactiveButton.disabled = offline;
      inactiveButton.title = "Hide this project from the home screen and pause recurring task generation.";
      inactiveButton.addEventListener("click", (event) => {
        event.stopPropagation();
        makeProjectInactive(project.id);
      });
      topRowActions.appendChild(inactiveButton);

      topRow.appendChild(topRowActions);

      const meta = document.createElement("div");
      meta.className = "project-card-meta";
      meta.appendChild(createChip(project.hasConfig ? "recurring" : "manual project"));
      if (projectTags.length) {
        projectTags.forEach((tag) => {
          meta.appendChild(createChip("tag", tag));
        });
      } else {
        meta.appendChild(createChip("no tags"));
      }
      meta.appendChild(createChip("due today", String(stats.dueToday)));
      meta.appendChild(createChip("overdue", String(stats.overdue)));
      meta.appendChild(createChip("no date", String(stats.noDueDate)));
      meta.appendChild(createChip("archived", String(stats.archived)));

      const footer = document.createElement("div");
      footer.className = "project-card-footer";
      footer.textContent = project.hasConfig && projectState.lastGeneratedThrough
        ? "Generated through " + formatDateShort(projectState.lastGeneratedThrough)
        : project.hasConfig
          ? "Not generated yet"
          : "No recurring config — add one from the project screen";

      card.appendChild(topRow);
      card.appendChild(meta);
      card.appendChild(footer);
      projectGrid.appendChild(card);
    });

    const viewInactiveBtn = $("#view-inactive-btn");
    if (viewInactiveBtn) {
      viewInactiveBtn.classList.toggle("hidden", !showProjectActions || getInactiveProjects().length === 0);
    }
  }

  async function deleteProject(projectId) {
    const project = getProjectMeta(projectId);
    if (!project) return;
    if (guardOffline()) return;

    if (!confirm('Delete project "' + project.name + '" and all its tasks?')) return;

    const saved = await runServerCommand("Deleting project from server...", async () => {
      if (appState.defaultProjectId === projectId) {
        const settingsResult = await supabase.schema("todo").from(USER_SETTINGS_TABLE).update({ default_project_id: null }).eq("user_id", currentUser.id);
        if (settingsResult.error) return settingsResult;
      }
      return supabase.schema("todo").from(PROJECTS_TABLE).delete().eq("user_id", currentUser.id).eq("id", projectId);
    });
    if (!saved) return;
    currentProjectId = null;
    renderHome();
    showScreen("home");
  }

  async function makeProjectInactive(projectId) {
    const project = getProjectMeta(projectId);
    if (!project) return;
    if (guardOffline()) return;

    await runServerCommand("Setting project inactive on server...", async () => {
      if (appState.defaultProjectId === projectId) {
        const settingsResult = await supabase.schema("todo").from(USER_SETTINGS_TABLE).update({ default_project_id: null }).eq("user_id", currentUser.id);
        if (settingsResult.error) return settingsResult;
      }
      return supabase.schema("todo").from(PROJECTS_TABLE).update({ inactive: true }).eq("user_id", currentUser.id).eq("id", projectId);
    });
  }

  async function reactivateProject(projectId) {
    if (guardOffline()) return;
    const saved = await runServerCommand("Reactivating project on server...", () =>
      supabase.schema("todo").from(PROJECTS_TABLE).update({ inactive: false }).eq("user_id", currentUser.id).eq("id", projectId)
    );
    if (saved) await generateTasksForProjectsOnServer([projectId]);
  }

  async function setDefaultProject(projectId) {
    if (guardOffline()) return;
    await runServerCommand("Saving default project on server...", () =>
      supabase.schema("todo").from(USER_SETTINGS_TABLE).upsert({
        user_id: currentUser.id,
        default_project_id: projectId,
        default_project_updated_at: nowIso(),
        updated_at: nowIso(),
      }, { onConflict: "user_id" })
    );
  }

  async function clearDefaultProject() {
    if (guardOffline()) return;
    await runServerCommand("Clearing default project on server...", () =>
      supabase.schema("todo").from(USER_SETTINGS_TABLE).upsert({
        user_id: currentUser.id,
        default_project_id: null,
        default_project_updated_at: nowIso(),
        updated_at: nowIso(),
      }, { onConflict: "user_id" })
    );
  }

  function updateRefreshButtons(project) {
    const projectButtons = ["#refresh-project-btn", "#refresh-day-project-btn"];
    const hasConfig = !!(project && project.hasConfig);
    projectButtons.forEach((selector) => {
      const button = $(selector);
      if (!button) return;
      button.disabled = !hasConfig;
      button.textContent = hasConfig ? "Refresh tasks" : "No recurring config";
      button.title = hasConfig ? "Generate any recurring tasks now" : "This project has no recurring config. Use the Configure button to add one.";
    });
  }

  function updateMutationButtonsForOffline() {
    const offline = !isOnline() || serverCommandInFlight;
    const mutationSelectors = [
      "#open-project-add-task-btn",
      "#open-day-add-task-btn",
      "#open-project-configure-btn",
      "#delete-archive-btn",
      "#refresh-project-btn",
      "#refresh-day-project-btn",
    ];
    mutationSelectors.forEach((sel) => {
      const btn = $(sel);
      if (!btn) return;
      // Only set disabled; the visible state (hidden) is managed elsewhere.
      if (offline) {
        btn.dataset.offlineDisabled = "1";
        btn.disabled = true;
      } else if (btn.dataset.offlineDisabled === "1") {
        delete btn.dataset.offlineDisabled;
        btn.disabled = false;
      }
    });
  }

  function ensureProjectTaskViewCardsContainer() {
    const projectScreen = $("#project-screen");
    if (!projectScreen) return null;

    let container = $("#project-task-view-cards") || $("#project-overdue-entry");
    if (!container) {
      container = document.createElement("div");
    }

    container.id = "project-task-view-cards";
    container.className = "project-task-view-cards";

    const nextSevenDaysPanel = projectScreen.querySelector("section.panel");
    if (nextSevenDaysPanel) {
      projectScreen.insertBefore(container, nextSevenDaysPanel);
      return container;
    }

    const projectActions = projectScreen.querySelector(".project-actions");
    if (projectActions) {
      projectActions.insertAdjacentElement("afterend", container);
      return container;
    }

    projectScreen.appendChild(container);
    return container;
  }

  function buildProjectTaskViewCard(titleText, detailText, descriptionText, onOpen, className, selected) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "day-card project-task-view-card"
      + (className ? " " + className : "")
      + (selected ? " selected" : "");
    card.addEventListener("click", onOpen);

    const title = document.createElement("div");
    title.className = "day-title";
    title.textContent = titleText;

    const detail = document.createElement("div");
    detail.className = "day-date";
    detail.textContent = detailText;

    const metrics = document.createElement("div");
    metrics.className = "day-metrics";
    metrics.appendChild(document.createTextNode(descriptionText));

    card.appendChild(title);
    card.appendChild(detail);
    card.appendChild(metrics);
    return card;
  }

  function renderProjectTaskViewCards(projectId) {
    const container = ensureProjectTaskViewCardsContainer();
    if (!container) return;
    container.innerHTML = "";

    const taskBuckets = getTaskBuckets(projectId, todayKey());
    const overdueTasks = taskBuckets.overdue;
    const noDateTasks = taskBuckets.noDate;
    const oldestDueDate = overdueTasks
      .map((task) => task.dueDate)
      .filter(Boolean)
      .sort(compareDateKeys)[0];

    if (overdueTasks.length) {
      container.appendChild(buildProjectTaskViewCard(
        "Overdue",
        overdueTasks.length + " overdue task" + (overdueTasks.length === 1 ? "" : "s"),
        oldestDueDate
          ? "Open overdue task list · Oldest due: " + formatDatePill(oldestDueDate)
          : "Open overdue task list",
        () => {
          openOverdue();
        },
        "overdue-entry-card has-overdue-tasks",
        selectedTaskView === "overdue"
      ));
    } else {
      const noOverdueLabel = document.createElement("p");
      noOverdueLabel.className = "project-task-view-empty-label";
      noOverdueLabel.textContent = "no overdue tasks";
      container.appendChild(noOverdueLabel);
    }

    if (noDateTasks.length) {
      container.appendChild(buildProjectTaskViewCard(
        "No Due Date",
        noDateTasks.length + " task" + (noDateTasks.length === 1 ? "" : "s") + " with no due date",
        "Open no due date task list",
        () => {
          openNoDueDate();
        },
        "nodate-entry-card",
        selectedTaskView === "nodate"
      ));
    } else {
      const noDateLabel = document.createElement("p");
      noDateLabel.className = "project-task-view-empty-label";
      noDateLabel.textContent = "no tasks without a due date";
      container.appendChild(noDateLabel);
    }
  }

  function configureTaskDateInput(inputId, defaultDate) {
    const input = $("#" + inputId);
    if (!input) return;
    input.min = todayKey();
    input.value = defaultDate || "";
  }

  function renderDayStrip(projectId) {
    const dayStrip = $("#day-strip");
    dayStrip.innerHTML = "";
    const today = todayKey();
    const futureTasks = getTaskBuckets(projectId, today).future;
    const nearestFutureDate = futureTasks
      .map((task) => task.dueDate)
      .filter(Boolean)
      .sort(compareDateKeys)[0];

    getVisibleDates().forEach((dateKey) => {
      const stats = getDayStats(projectId, dateKey);
      if (!stats.required && dateKey !== today) return;

      const title = document.createElement("div");
      title.className = "day-title";
      title.textContent = formatDayCardHeader(dateKey);

      const metrics = document.createElement("div");
      metrics.className = "day-metrics";

      if (!stats.required) {
        const emptyCard = document.createElement("div");
        emptyCard.className = "day-card today empty-day-card";
        metrics.appendChild(document.createTextNode("No tasks due today"));
        emptyCard.appendChild(title);
        emptyCard.appendChild(metrics);
        dayStrip.appendChild(emptyCard);
        return;
      }

      const card = document.createElement("button");
      card.type = "button";
      card.className = "day-card";
      if (dateKey === today) card.classList.add("today");
      if (selectedTaskView === "day" && dateKey === selectedDate) card.classList.add("selected");
      card.addEventListener("click", () => {
        openDay(dateKey);
      });

      const remainingSummary = "Remaining tasks: " + stats.incomplete + " of " + stats.required;
      metrics.appendChild(
        document.createTextNode(
          stats.incomplete
            ? remainingSummary + formatIncompleteTaskBreakdown(stats.incomplete, stats.pinned, stats.endOfDay)
            : remainingSummary + " (All tasks complete)"
        )
      );

      card.appendChild(title);
      card.appendChild(metrics);
      dayStrip.appendChild(card);
    });

    const futureCard = document.createElement("button");
    futureCard.type = "button";
    futureCard.className = "day-card";
    if (selectedTaskView === "future") futureCard.classList.add("selected");
    futureCard.addEventListener("click", () => {
      openFutureTasks();
    });

    const futureTitle = document.createElement("div");
    futureTitle.className = "day-title";
    futureTitle.textContent = "Other Future Tasks";

    const futureDate = document.createElement("div");
    futureDate.className = "day-date";
    futureDate.textContent = futureTasks.length
      ? futureTasks.length + " task" + (futureTasks.length === 1 ? "" : "s") + " beyond 7 days"
      : "No tasks beyond 7 days";

    const futureMetrics = document.createElement("div");
    futureMetrics.className = "day-metrics";
    futureMetrics.appendChild(document.createTextNode(
      nearestFutureDate
        ? "Next due: " + formatDatePill(nearestFutureDate)
        : "Open future task list"
    ));

    futureCard.appendChild(futureTitle);
    futureCard.appendChild(futureDate);
    futureCard.appendChild(futureMetrics);
    dayStrip.appendChild(futureCard);
  }

  function renderSummary(projectId) {
    const summary = $("#project-summary");
    summary.innerHTML = "";
    const stats = buildProjectStats(projectId);

    [
      { label: "Active", value: stats.active },
      { label: "Due Today", value: stats.dueToday },
      { label: "Overdue", value: stats.overdue },
      { label: "No Due Date", value: stats.noDueDate },
    ].forEach((item) => {
      const card = document.createElement("div");
      card.className = "summary-card";

      const label = document.createElement("span");
      label.className = "summary-label";
      label.textContent = item.label;

      const value = document.createElement("span");
      value.className = "summary-value";
      value.textContent = String(item.value);

      card.appendChild(label);
      card.appendChild(value);
      summary.appendChild(card);
    });
  }

  function updateArchiveButtonLabel() {
    const button = $("#view-archive-btn");
    if (!button || !currentProjectId) return;
    const stats = buildProjectStats(currentProjectId);
    button.textContent = "View archive (" + stats.archived + ")";
  }

  function getTaskExpandKey(task) {
    return task.projectId + "::" + task.id;
  }

  function isTaskExpanded(task) {
    return !!expandedTaskCards[getTaskExpandKey(task)];
  }

  function setTaskExpanded(task, expanded) {
    const key = getTaskExpandKey(task);
    if (expanded) {
      expandedTaskCards[key] = true;
      return;
    }
    delete expandedTaskCards[key];
  }

  function renderTaskListControls() {
    const controls = $("#task-list-controls");
    if (!controls) return;

    controls.innerHTML = "";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "task-list-toggle" + (condensedMode ? " active" : "");
    toggle.setAttribute("aria-pressed", condensedMode ? "true" : "false");
    toggle.textContent = condensedMode ? "Condensed mode: On" : "Condensed mode: Off";
    toggle.addEventListener("click", () => {
      condensedMode = !condensedMode;
      if (!condensedMode) {
        expandedTaskCards = {};
      }
      if (currentProjectId && $("#day-screen").classList.contains("active")) {
        renderTaskSections(currentProjectId);
      }
    });

    controls.appendChild(toggle);

    const countdownToggle = document.createElement("button");
    countdownToggle.type = "button";
    countdownToggle.className = "task-list-toggle" + (countdownEnabled ? " active" : "");
    countdownToggle.setAttribute("aria-pressed", countdownEnabled ? "true" : "false");
    countdownToggle.textContent = countdownEnabled ? "Completion countdown: On" : "Completion countdown: Off";
    countdownToggle.addEventListener("click", () => {
      countdownEnabled = !countdownEnabled;
      countdownToggle.className = "task-list-toggle" + (countdownEnabled ? " active" : "");
      countdownToggle.setAttribute("aria-pressed", countdownEnabled ? "true" : "false");
      countdownToggle.textContent = countdownEnabled ? "Completion countdown: On" : "Completion countdown: Off";
    });

    controls.appendChild(countdownToggle);

    if (selectedTaskView === "overdue" && currentProjectId) {
      const overdueCount = getTaskBuckets(currentProjectId, selectedDate).overdue.length;
      if (overdueCount > 0) {
        const offline = !isOnline();
        const deferAllButton = document.createElement("button");
        deferAllButton.type = "button";
        deferAllButton.className = "btn-secondary";
        deferAllButton.textContent = "Defer all overdue to today";
        deferAllButton.disabled = offline;
        deferAllButton.addEventListener("click", deferAllOverdueTasksToToday);
        controls.appendChild(deferAllButton);

        const completeAllButton = document.createElement("button");
        completeAllButton.type = "button";
        completeAllButton.className = "btn-danger";
        completeAllButton.textContent = "Complete all overdue";
        completeAllButton.disabled = offline;
        completeAllButton.addEventListener("click", completeAllOverdueTasks);
        controls.appendChild(completeAllButton);
      }
    }
  }

  function buildTaskMeta(task, archived) {
    const meta = document.createElement("div");
    meta.className = "task-meta";

    if (task.dueDate) {
      meta.appendChild(createChip("due " + formatDateShort(task.dueDate)));
    } else {
      meta.appendChild(createChip("no due date"));
    }

    meta.appendChild(createChip(task.source === "generated" ? "recurring" : "manual"));

    if (archived && task.completedAt) {
      meta.appendChild(createChip("completed " + formatTimestamp(task.completedAt)));
    }

    return meta;
  }

  function linkify(text) {
    const urlPattern = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+/g;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match;
    while ((match = urlPattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      // Strip trailing punctuation that is unlikely to be part of the URL
      let url = match[0].replace(/[.,!?;:]+$/, "");
      // Strip trailing unbalanced closing parentheses
      let opens = (url.match(/\(/g) || []).length;
      let closes = (url.match(/\)/g) || []).length;
      while (closes > opens && url.endsWith(")")) {
        url = url.slice(0, -1);
        closes--;
      }
      const a = document.createElement("a");
      a.href = url.startsWith("www.") ? "https://" + url : url;
      a.textContent = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      fragment.appendChild(a);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    return fragment;
  }

  function buildTaskCard(task, options) {
    const card = document.createElement("div");
    const offline = !isOnline();
    card.className = "task-card";
    if (options.overdue) card.classList.add("overdue");
    if (!task.dueDate) card.classList.add("nodate");
    if (!options.archived && task.pinned) card.classList.add("pinned");
    if (!options.archived && task.endOfDay) card.classList.add("end-of-day");
    const condensedCard = condensedMode && !options.archived;
    const expandedInCondensed = condensedCard ? isTaskExpanded(task) : false;
    if (condensedCard && !expandedInCondensed) card.classList.add("condensed");

    const titleRow = document.createElement("div");
    titleRow.className = "task-card-title-row";

    const title = document.createElement("h4");
    title.appendChild(linkify(task.name));
    titleRow.appendChild(title);

    if (!options.archived && task.pinned) {
      const pinBadge = document.createElement("span");
      pinBadge.className = "pin-badge";
      pinBadge.textContent = "📌 Pinned";
      titleRow.appendChild(pinBadge);
    }

    if (!options.archived && task.endOfDay) {
      const endOfDayBadge = document.createElement("span");
      endOfDayBadge.className = "end-of-day-badge";
      endOfDayBadge.textContent = "🌙 End of Day";
      titleRow.appendChild(endOfDayBadge);
    }

    card.appendChild(titleRow);

    const actions = document.createElement("div");
    actions.className = "task-actions";

    if (condensedCard && !expandedInCondensed) {
      const requiresDescriptionReview = !!task.description;
      const pendingCountdownLabel = getTaskCompletionCountdownLabel(task.id);
      const completeButton = document.createElement("button");
      completeButton.type = "button";
      completeButton.className = "task-btn complete";
      if (pendingCountdownLabel) completeButton.classList.add("countdown");
      completeButton.textContent = pendingCountdownLabel || (requiresDescriptionReview ? "Complete..." : "Complete");
      if (requiresDescriptionReview) {
        completeButton.setAttribute("aria-label", "Review description before completing task");
      }
      completeButton.addEventListener("click", () => {
        if (getPendingTaskCompletion(task.id)) {
          cancelPendingTaskCompletion(task.id);
          return;
        }
        if (requiresDescriptionReview) {
          setTaskExpanded(task, true);
          if (currentProjectId) {
            renderTaskSections(currentProjectId);
          }
          return;
        }
        completeTask(task.id);
      });
      completeButton.disabled = offline;

      const deferButton = document.createElement("button");
      deferButton.type = "button";
      deferButton.className = "task-btn defer";
      deferButton.textContent = task.dueDate ? "Defer" : "Schedule";
      deferButton.disabled = offline;
      deferButton.addEventListener("click", () => {
        openDeferModal(task.id);
      });

      const pinButton = document.createElement("button");
      pinButton.type = "button";
      pinButton.className = "task-btn pin";
      pinButton.textContent = task.pinned ? "Unpin" : "Pin";
      pinButton.disabled = offline;
      pinButton.addEventListener("click", () => {
        togglePinTask(task.id);
      });

      const endOfDayButton = document.createElement("button");
      endOfDayButton.type = "button";
      endOfDayButton.className = "task-btn end-of-day";
      endOfDayButton.textContent = task.endOfDay ? "Remove End of Day" : "End of Day";
      endOfDayButton.disabled = offline;
      endOfDayButton.addEventListener("click", () => {
        toggleEndOfDayTask(task.id);
      });

      const expandButton = document.createElement("button");
      expandButton.type = "button";
      expandButton.className = "task-btn expand";
      expandButton.textContent = "Expand";
      expandButton.addEventListener("click", () => {
        setTaskExpanded(task, true);
        if (currentProjectId) {
          renderTaskSections(currentProjectId);
        }
      });

      actions.appendChild(completeButton);
      actions.appendChild(deferButton);
      actions.appendChild(pinButton);
      actions.appendChild(endOfDayButton);
      actions.appendChild(expandButton);
      card.appendChild(actions);
      return card;
    }

    if (task.description) {
      const description = document.createElement("p");
      description.className = "task-description";
      description.appendChild(linkify(task.description));
      card.appendChild(description);
    }

    card.appendChild(buildTaskMeta(task, options.archived));

    if (options.archived) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "task-btn delete";
      deleteButton.textContent = "Delete";
      deleteButton.disabled = offline;
      deleteButton.addEventListener("click", () => {
        deleteArchivedTask(task.id);
      });
      actions.appendChild(deleteButton);
    } else {
      const pendingCountdownLabel = getTaskCompletionCountdownLabel(task.id);
      const completeButton = document.createElement("button");
      completeButton.type = "button";
      completeButton.className = "task-btn complete";
      if (pendingCountdownLabel) completeButton.classList.add("countdown");
      completeButton.textContent = pendingCountdownLabel || "Complete";
      completeButton.disabled = offline;
      completeButton.addEventListener("click", () => {
        completeTask(task.id);
      });

      const deferButton = document.createElement("button");
      deferButton.type = "button";
      deferButton.className = "task-btn defer";
      deferButton.textContent = task.dueDate ? "Defer" : "Schedule";
      deferButton.disabled = offline;
      deferButton.addEventListener("click", () => {
        openDeferModal(task.id);
      });

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "task-btn edit";
      editButton.textContent = "Edit";
      editButton.disabled = offline;
      editButton.addEventListener("click", () => {
        openEditModal(task.id);
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "task-btn delete";
      deleteButton.textContent = "Delete";
      deleteButton.disabled = offline;
      deleteButton.addEventListener("click", () => {
        hardDeleteTask(task.id);
      });

      actions.appendChild(completeButton);
      actions.appendChild(deferButton);
      actions.appendChild(editButton);
      actions.appendChild(deleteButton);

      const pinButton = document.createElement("button");
      pinButton.type = "button";
      pinButton.className = "task-btn pin";
      pinButton.textContent = task.pinned ? "Unpin" : "Pin";
      pinButton.disabled = offline;
      pinButton.addEventListener("click", () => {
        togglePinTask(task.id);
      });
      actions.appendChild(pinButton);

      const endOfDayButton = document.createElement("button");
      endOfDayButton.type = "button";
      endOfDayButton.className = "task-btn end-of-day";
      endOfDayButton.textContent = task.endOfDay ? "Remove End of Day" : "End of Day";
      endOfDayButton.disabled = offline;
      endOfDayButton.addEventListener("click", () => {
        toggleEndOfDayTask(task.id);
      });
      actions.appendChild(endOfDayButton);

      if (condensedCard && expandedInCondensed) {
        const collapseButton = document.createElement("button");
        collapseButton.type = "button";
        collapseButton.className = "task-btn expand";
        collapseButton.textContent = "Collapse";
        collapseButton.addEventListener("click", () => {
          setTaskExpanded(task, false);
          if (currentProjectId) {
            renderTaskSections(currentProjectId);
          }
        });
        actions.appendChild(collapseButton);
      }
    }

    card.appendChild(actions);
    return card;
  }

  function buildTaskSection(titleText, tasks, options) {
    const section = document.createElement("section");
    section.className = "section-card";

    const header = document.createElement("div");
    header.className = "section-header";

    const title = document.createElement("h3");
    title.textContent = titleText;

    const count = document.createElement("div");
    count.className = "section-count";
    const taskCategoryCounts = options.archived
      ? { pinned: 0, endOfDay: 0 }
      : getIncompleteTaskCategoryCounts(tasks);
    count.textContent =
      tasks.length +
      " task" +
      (tasks.length === 1 ? "" : "s") +
      (options.archived
        ? ""
        : formatIncompleteTaskBreakdown(
            tasks.length,
            taskCategoryCounts.pinned,
            taskCategoryCounts.endOfDay
          ));

    header.appendChild(title);
    header.appendChild(count);
    section.appendChild(header);

    if (!tasks.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = options.emptyMessage || "Nothing here right now.";
      section.appendChild(empty);
      return section;
    }

    const list = document.createElement("div");
    list.className = `task-list${condensedMode && !options.archived ? " condensed" : ""}`;
    tasks.forEach((task) => {
      list.appendChild(buildTaskCard(task, options));
    });
    section.appendChild(list);
    return section;
  }

  function getTaskBuckets(projectId, dateKey) {
    const today = todayKey();
    const visibleEnd = addDays(today, 6);
    const tasks = sortActiveTasks(getProjectTasks(projectId));
    return {
      overdue: tasks.filter((task) => task.dueDate && compareDateKeys(task.dueDate, today) < 0),
      selected: tasks.filter((task) => task.dueDate === dateKey),
      future: tasks.filter((task) => task.dueDate && compareDateKeys(task.dueDate, visibleEnd) > 0),
      noDate: tasks.filter((task) => !task.dueDate),
    };
  }

  function renderTaskSections(projectId) {
    renderTaskListControls();

    const taskSections = $("#task-sections");
    taskSections.innerHTML = "";

    const taskBuckets = getTaskBuckets(projectId, selectedDate);

    if (selectedTaskView === "overdue") {
      taskSections.appendChild(buildTaskSection("Overdue", taskBuckets.overdue, {
        overdue: true,
        archived: false,
        emptyMessage: "No overdue tasks right now.",
      }));
      return;
    }

    if (selectedTaskView === "nodate") {
      taskSections.appendChild(buildTaskSection("No Due Date", taskBuckets.noDate, {
        overdue: false,
        archived: false,
        emptyMessage: "No tasks without a due date right now.",
      }));
      return;
    }

    if (selectedTaskView === "future") {
      taskSections.appendChild(buildTaskSection("Other Future Tasks", taskBuckets.future, {
        overdue: false,
        archived: false,
        emptyMessage: "No tasks are due beyond the next 7 days.",
      }));
      return;
    }

    if (selectedTaskView === "all") {
      const today = todayKey();
      const allTasks = sortActiveTasks(getProjectTasks(projectId));
      const overdueAll = [];
      const todayAll = [];
      const futureDatedByDay = {};
      const undatedAll = [];
      allTasks.forEach((task) => {
        if (task.dueDate && compareDateKeys(task.dueDate, today) < 0) {
          overdueAll.push(task);
        } else if (task.dueDate === today) {
          todayAll.push(task);
        } else if (task.dueDate) {
          if (!futureDatedByDay[task.dueDate]) {
            futureDatedByDay[task.dueDate] = [];
          }
          futureDatedByDay[task.dueDate].push(task);
        } else {
          undatedAll.push(task);
        }
      });
      if (overdueAll.length) {
        taskSections.appendChild(buildTaskSection("Overdue", overdueAll, {
          overdue: true,
          archived: false,
          emptyMessage: "",
        }));
      }
      if (todayAll.length) {
        const todayWrapper = document.createElement("div");
        todayWrapper.className = "today-tasks-wrapper";
        todayWrapper.appendChild(buildTaskSection("Today · " + formatDateLong(today), todayAll, {
          overdue: false,
          archived: false,
          emptyMessage: "",
        }));
        taskSections.appendChild(todayWrapper);
      }
      const futureDays = Object.keys(futureDatedByDay).sort(compareDateKeys);
      futureDays.forEach((dateKey) => {
        taskSections.appendChild(buildTaskSection(formatDateLong(dateKey), futureDatedByDay[dateKey], {
          overdue: false,
          archived: false,
          emptyMessage: "No tasks due on this day.",
        }));
      });
      if (undatedAll.length) {
        taskSections.appendChild(buildTaskSection("No Due Date", undatedAll, {
          overdue: false,
          archived: false,
          emptyMessage: "No tasks without a due date.",
        }));
      }
      return;
    }

    taskSections.appendChild(buildTaskSection(formatDateLong(selectedDate), taskBuckets.selected, {
      overdue: false,
      archived: false,
      emptyMessage: "No tasks are due on this day.",
    }));
  }

  function renderProject() {
    if (!currentProjectId) return;

    const project = getProjectMeta(currentProjectId);
    if (!project) {
      renderHome();
      showScreen("home");
      return;
    }

    ensureProjectState(project.id, project.name);

    $("#project-title").textContent = project.name;
    $("#project-subtitle").textContent = project.hasConfig
      ? "Select a day to view its tasks."
      : "No recurring config. Use the Configure button to add one, or add tasks manually.";

    renderProjectTaskViewCards(project.id);
    renderDayStrip(project.id);
    renderSummary(project.id);
    updateRefreshButtons(project);
    updateMutationButtonsForOffline();
    showScreen("project");
  }

  function renderDayView() {
    if (!currentProjectId) return;

    const project = getProjectMeta(currentProjectId);
    if (!project) {
      renderHome();
      showScreen("home");
      return;
    }

    if (selectedTaskView === "overdue") {
      const overdueCount = getTaskBuckets(project.id, selectedDate).overdue.length;
      $("#day-title").textContent = "Overdue";
      $("#day-subtitle").textContent = project.name + " · " + overdueCount + " overdue task" + (overdueCount === 1 ? "" : "s");
    } else if (selectedTaskView === "nodate") {
      const noDateCount = getTaskBuckets(project.id, selectedDate).noDate.length;
      $("#day-title").textContent = "No Due Date";
      $("#day-subtitle").textContent = project.name + " · " + noDateCount + " task" + (noDateCount === 1 ? "" : "s") + " with no due date";
    } else if (selectedTaskView === "future") {
      const futureCount = getTaskBuckets(project.id, selectedDate).future.length;
      $("#day-title").textContent = "Other Future Tasks";
      $("#day-subtitle").textContent = project.name + " · " + futureCount + " task" + (futureCount === 1 ? "" : "s") + " beyond the next 7 days";
    } else if (selectedTaskView === "all") {
      const allCount = getProjectTasks(project.id).length;
      $("#day-title").textContent = "All Tasks";
      $("#day-subtitle").textContent = project.name + " · " + allCount + " task" + (allCount === 1 ? "" : "s");
    } else {
      const stats = getDayStats(project.id, selectedDate);
      $("#day-title").textContent = formatDateLong(selectedDate);
      $("#day-subtitle").textContent = project.name + " · " + stats.incomplete + " incomplete · " + stats.complete + " complete";
    }

    updateArchiveButtonLabel();
    renderTaskListControls();
    renderTaskSections(project.id);
    updateRefreshButtons(project);
    updateMutationButtonsForOffline();
    showScreen("day");
  }

  function renderArchiveScreen() {
    if (!currentProjectId) return;

    const project = getProjectMeta(currentProjectId);
    const archiveList = $("#archive-list");
    const emptyState = $("#archive-empty");
    archiveList.innerHTML = "";

    $("#archive-title").textContent = project ? project.name + " Archive" : "Archive";

    const archivedTasks = sortArchivedTasks(getProjectArchivedTasks(currentProjectId));
    if (!archivedTasks.length) {
      emptyState.classList.remove("hidden");
      return;
    }

    emptyState.classList.add("hidden");
    archiveList.appendChild(buildTaskSection("Completed Tasks", archivedTasks, {
      archived: true,
      emptyMessage: "No archived tasks yet.",
    }));
    updateMutationButtonsForOffline();
  }

  function renderCurrentScreen() {
    if ($("#inactive-screen").classList.contains("active")) {
      renderInactiveProjects();
      return;
    }

    if ($("#archive-screen").classList.contains("active")) {
      renderArchiveScreen();
      return;
    }

    if ($("#day-screen").classList.contains("active")) {
      renderDayView();
      return;
    }

    if ($("#project-screen").classList.contains("active")) {
      renderProject();
      return;
    }

    renderHome();
  }

  function openProject(projectId) {
    currentProjectId = projectId;
    selectedDate = todayKey();
    selectedTaskView = "day";
    renderProject();
  }

  function openDay(dateKey) {
    selectedDate = dateKey;
    selectedTaskView = "day";
    renderDayView();
  }

  function openOverdue() {
    selectedTaskView = "overdue";
    renderDayView();
  }

  function openNoDueDate() {
    selectedTaskView = "nodate";
    renderDayView();
  }

  function openAllTasks() {
    selectedTaskView = "all";
    renderDayView();
  }

  function openFutureTasks() {
    selectedTaskView = "future";
    renderDayView();
  }

  function openArchive() {
    renderArchiveScreen();
    showScreen("archive");
  }

  function renderInactiveProjects() {
    const listEl = $("#inactive-project-list");
    const emptyEl = $("#inactive-empty");
    if (!listEl || !emptyEl) return;

    listEl.innerHTML = "";
    const projects = getInactiveProjects();

    if (!projects.length) {
      emptyEl.classList.remove("hidden");
      return;
    }

    emptyEl.classList.add("hidden");

    projects.forEach((project) => {
      const card = document.createElement("div");
      card.className = "project-card";

      const topRow = document.createElement("div");
      topRow.className = "project-card-top";

      const title = document.createElement("div");
      title.className = "project-card-title";
      title.textContent = project.name;

      const topRowActions = document.createElement("div");
      topRowActions.className = "project-card-top-actions";

      const reactivateButton = document.createElement("button");
      reactivateButton.type = "button";
      reactivateButton.className = "btn-secondary project-card-reactivate";
      reactivateButton.textContent = "Reactivate";
      reactivateButton.title = "Show this project on the home screen and resume recurring task generation.";
      reactivateButton.disabled = !isOnline();
      reactivateButton.addEventListener("click", () => {
        reactivateProject(project.id);
      });
      topRowActions.appendChild(reactivateButton);

      topRow.appendChild(title);
      topRow.appendChild(topRowActions);
      card.appendChild(topRow);

      const meta = document.createElement("div");
      meta.className = "project-card-meta";
      meta.appendChild(createChip(project.hasConfig ? "recurring" : "manual project"));
      meta.appendChild(createChip("inactive"));
      card.appendChild(meta);

      listEl.appendChild(card);
    });
  }

  function openInactiveProjects() {
    renderInactiveProjects();
    showScreen("inactive");
  }

  function getActiveTask(taskId) {
    if (!currentProjectId) return null;
    return getProjectState(currentProjectId).tasks[taskId] || null;
  }

  async function addManualTaskFromForm(nameInputId, descriptionInputId, dateInputId) {
    if (guardOffline()) return false;
    const select = $("#add-task-project-select");
    const targetProjectId = (select && select.value) ? select.value : currentProjectId;
    if (!targetProjectId) return false;

    const nameInput = $("#" + nameInputId);
    const descriptionInput = $("#" + descriptionInputId);
    const dateInput = $("#" + dateInputId);
    const name = nameInput.value.trim();
    const description = descriptionInput.value.trim();

    if (!name) return false;

    const timestamp = nowIso();
    const taskId = createId("task");
    const dueDate = isDateKey(dateInput.value) ? dateInput.value : null;

    const saved = await runServerCommand("Adding task to server...", () =>
      supabase.schema("todo").from(TASKS_TABLE).insert({
        user_id: currentUser.id,
        project_id: targetProjectId,
        id: taskId,
        name,
        due_date: dueDate,
        source: "manual",
        generated_key: null,
        pinned: false,
        end_of_day: false,
        body: description,
        created_at: timestamp,
        updated_at: timestamp,
      })
    );
    if (!saved) return false;

    nameInput.value = "";
    descriptionInput.value = "";
    dateInput.value = "";

    const targetProjectMeta = getProjectMeta(targetProjectId);
    const targetProjectName = targetProjectMeta ? targetProjectMeta.name : targetProjectId;

    if (targetProjectId !== currentProjectId) {
      // Task was added to a different project than the one currently being viewed
      const dateStr = dueDate ? formatDateDisplay(dueDate) : null;
      const msg = dateStr
        ? "Task '" + name + "' added to project '" + targetProjectName + "' with due date of " + dateStr + "."
        : "Task '" + name + "' successfully added to project '" + targetProjectName + "'.";
      showToast(msg);
    } else if (!isTaskVisibleInCurrentView(dueDate)) {
      const dateStr = dueDate ? formatDateDisplay(dueDate) : null;
      const msg = dateStr
        ? "Task '" + name + "' created with due date of " + dateStr + "."
        : "Task '" + name + "' created with no due date.";
      showToast(msg);
    }

    return true;
  }

  function openCreateProjectPanel() {
    const panel = $("#create-project-panel");
    const openButton = $("#open-create-project-btn");
    const input = $("#create-project-name-input");
    if (!panel.classList.contains("hidden")) return;
    panel.classList.remove("hidden");
    openButton.classList.add("hidden");
    openButton.setAttribute("aria-expanded", "true");
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    requestAnimationFrame(() => {
      try {
        input.focus({ preventScroll: true });
      } catch (error) {
        input.focus();
      }
    });
  }

  function closeCreateProjectPanel() {
    const panel = $("#create-project-panel");
    const openButton = $("#open-create-project-btn");
    const input = $("#create-project-name-input");
    if (panel.classList.contains("hidden")) return;
    panel.classList.add("hidden");
    openButton.classList.remove("hidden");
    openButton.setAttribute("aria-expanded", "false");
    input.value = "";
    const tagsInput = $("#create-project-tags-input");
    if (tagsInput) tagsInput.value = "";
  }

  async function setProjectTags(projectId, nextTags) {
    const projectState = getProjectState(projectId);
    const normalizedTags = normalizeTagList(nextTags);
    const currentTags = normalizeTagList(projectState.tags);
    if (currentTags.join("|") === normalizedTags.join("|")) {
      return false;
    }
    return runServerCommand("Saving project tags on server...", async () => {
      const deleteResult = await supabase.schema("todo").from(PROJECT_TAGS_TABLE).delete().eq("user_id", currentUser.id).eq("project_id", projectId);
      if (deleteResult.error || !normalizedTags.length) return deleteResult;
      const tagsResult = await supabase.schema("todo").from(TAGS_TABLE).upsert(
        normalizedTags.map((tag) => ({ user_id: currentUser.id, tag })),
        { onConflict: "user_id,tag" }
      );
      if (tagsResult.error) return tagsResult;
      return supabase.schema("todo").from(PROJECT_TAGS_TABLE).insert(
        normalizedTags.map((tag) => ({ user_id: currentUser.id, project_id: projectId, tag }))
      );
    });
  }

  async function promptEditProjectTags(projectId) {
    const project = getProjectMeta(projectId);
    if (!project) return;
    if (guardOffline()) return;
    const initialValue = formatProjectTags(project.tags);
    const entered = prompt('Edit tags for "' + project.name + '" (comma separated):', initialValue);
    if (entered === null) return;
    const nextTags = parseTagInput(entered);
    await setProjectTags(projectId, nextTags);
  }

  function getTagFilteredProjects(projects, selectedTags) {
    if (!selectedTags || selectedTags.size === 0) return projects;
    return projects.filter((project) => project.tags.some((tag) => selectedTags.has(tag)));
  }

  function renderHomeTagFilters(allVisibleProjects) {
    const panel = $("#project-tag-filters");
    const options = $("#project-tag-filter-options");
    const summary = $("#project-tag-filter-summary");
    if (!panel || !options || !summary) return;

    const availableTagSet = new Set();
    allVisibleProjects.forEach((project) => {
      normalizeTagList(project.tags).forEach((tag) => availableTagSet.add(tag));
    });
    const availableTags = Array.from(availableTagSet).sort((a, b) => a.localeCompare(b));

    const cleanedFilters = new Set();
    selectedProjectTagFilters.forEach((tag) => {
      if (availableTagSet.has(tag)) {
        cleanedFilters.add(tag);
      }
    });
    if (cleanedFilters.size !== selectedProjectTagFilters.size) {
      selectedProjectTagFilters = cleanedFilters;
      saveProjectTagFilters();
    }

    if (!availableTags.length) {
      panel.classList.add("hidden");
      options.innerHTML = "";
      summary.textContent = "";
      return;
    }

    panel.classList.remove("hidden");
    options.innerHTML = "";

    const allLabel = document.createElement("label");
    allLabel.className = "tag-filter-option tag-filter-option-all";
    const allCheckbox = document.createElement("input");
    allCheckbox.type = "checkbox";
    allCheckbox.checked = selectedProjectTagFilters.size === 0;
    allCheckbox.addEventListener("change", () => {
      if (allCheckbox.checked) {
        selectedProjectTagFilters = new Set();
        saveProjectTagFilters();
        renderHome();
      } else if (availableTags.length) {
        selectedProjectTagFilters = new Set([availableTags[0]]);
        saveProjectTagFilters();
        renderHome();
      }
    });
    const allText = document.createElement("span");
    allText.textContent = "All";
    allLabel.appendChild(allCheckbox);
    allLabel.appendChild(allText);
    options.appendChild(allLabel);

    availableTags.forEach((tag) => {
      const label = document.createElement("label");
      label.className = "tag-filter-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedProjectTagFilters.has(tag);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selectedProjectTagFilters.add(tag);
        } else {
          selectedProjectTagFilters.delete(tag);
        }
        saveProjectTagFilters();
        renderHome();
      });
      const text = document.createElement("span");
      text.textContent = tag;
      label.appendChild(checkbox);
      label.appendChild(text);
      options.appendChild(label);
    });

    const filteredCount = getTagFilteredProjects(allVisibleProjects, selectedProjectTagFilters).length;
    summary.textContent = selectedProjectTagFilters.size === 0
      ? "Showing all projects"
      : "Showing " + filteredCount + " project" + (filteredCount === 1 ? "" : "s") + " matching selected tags";
  }

  async function createManualProject(event) {
    event.preventDefault();
    if (guardOffline()) return;

    const nameInput = $("#create-project-name-input");
    const tagsInput = $("#create-project-tags-input");
    const name = nameInput.value.trim();
    const tags = parseTagInput(tagsInput ? tagsInput.value : "");
    if (!name) return;

    const existingProject = [...getAllProjects(), ...getInactiveProjects()].find((project) => project.name.toLowerCase() === name.toLowerCase());
    if (existingProject) {
      setSyncStatus(existingProject.inactive
        ? 'An inactive project named "' + name + '" already exists. Reactivate it from Inactive projects.'
        : 'A project named "' + name + '" already exists.');
      nameInput.focus();
      nameInput.select();
      return;
    }

    const projectId = buildProjectId(name);
    const saved = await runServerCommand("Creating project on server...", async () => {
      const projectResult = await supabase.schema("todo").from(PROJECTS_TABLE).insert({
        user_id: currentUser.id,
        id: projectId,
        name,
        inactive: false,
        last_generated_through: null,
        config_text: "",
      });
      if (projectResult.error || !tags.length) return projectResult;
      const tagsResult = await supabase.schema("todo").from(TAGS_TABLE).upsert(
        tags.map((tag) => ({ user_id: currentUser.id, tag })),
        { onConflict: "user_id,tag" }
      );
      if (tagsResult.error) return tagsResult;
      return supabase.schema("todo").from(PROJECT_TAGS_TABLE).insert(
        tags.map((tag) => ({ user_id: currentUser.id, project_id: projectId, tag }))
      );
    });
    if (!saved) return;
    nameInput.value = "";
    closeCreateProjectPanel();
    openProject(projectId);
  }



  // --- Project configuration modal ---

  /**
   * Populates the task-name dropdown in the "Default task descriptions" form
   * with the task names currently present in the config textarea.
   */
  function refreshRtdTaskNameDropdown() {
    const select = $("#rtd-task-name-input");
    if (!select) return;
    const textarea = $("#config-modal-textarea");
    const configText = textarea ? textarea.value : "";
    const rules = parseProjectConfig(configText);
    const taskNames = Array.from(new Set(rules.map((r) => r.name))).sort();

    // Preserve the currently selected value if it still exists.
    const previousValue = select.value;
    select.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = taskNames.length ? "— Select a task —" : "— No tasks in config —";
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);

    taskNames.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });

    // Restore previous selection if still valid.
    if (previousValue && taskNames.includes(previousValue)) {
      select.value = previousValue;
    }
  }

  function openConfigModal(projectId) {
    configModalProjectId = projectId;
    const textarea = $("#config-modal-textarea");
    const errorEl = $("#config-modal-error");
    if (textarea) {
      textarea.value = projectConfigTexts[projectId] || "";
    }
    if (errorEl) {
      errorEl.textContent = "";
      errorEl.classList.add("hidden");
    }
    resetTaskBuilder();
    // Clear any previously entered description form fields.
    const rtdDescInput = $("#rtd-description-input");
    if (rtdDescInput) rtdDescInput.value = "";
    const rtdErrorEl = $("#rtd-error");
    if (rtdErrorEl) { rtdErrorEl.textContent = ""; rtdErrorEl.classList.add("hidden"); }
    refreshRtdTaskNameDropdown();
    renderRecurringTaskDescriptionsList(projectId);
    openModal("config-modal", "#builder-task-name");
  }

  function closeConfigModal() {
    configModalProjectId = null;
    closeModal("config-modal");
    resetTaskBuilder();
  }

  function resetTaskBuilder() {
    const nameInput = $("#builder-task-name");
    if (nameInput) nameInput.value = "";
    const weeklyRadio = document.querySelector('input[name="builder-cadence"][value="weekly"]');
    if (weeklyRadio) weeklyRadio.checked = true;
    document.querySelectorAll('input[name="builder-weekday"]').forEach((cb) => { cb.checked = false; });
    const monthlyInput = $("#builder-monthly-dates");
    if (monthlyInput) monthlyInput.value = "";
    const annualMonthInput = $("#builder-annual-month");
    if (annualMonthInput) annualMonthInput.value = "1";
    const annualDayInput = $("#builder-annual-day");
    if (annualDayInput) annualDayInput.value = "";
    const everyWeeksInterval = $("#builder-every-weeks-interval");
    if (everyWeeksInterval) everyWeeksInterval.value = "";
    const everyWeeksStart = $("#builder-every-weeks-start");
    if (everyWeeksStart) everyWeeksStart.value = "";
    const everyMonthsInterval = $("#builder-every-months-interval");
    if (everyMonthsInterval) everyMonthsInterval.value = "";
    const everyMonthsStart = $("#builder-every-months-start");
    if (everyMonthsStart) everyMonthsStart.value = "";
    const builderError = $("#builder-error");
    if (builderError) { builderError.textContent = ""; builderError.classList.add("hidden"); }
    updateBuilderScheduleVisibility();
  }

  function updateBuilderScheduleVisibility() {
    const cadence = document.querySelector('input[name="builder-cadence"]:checked');
    const weekly = $("#builder-weekly-schedule");
    const monthly = $("#builder-monthly-schedule");
    const annual = $("#builder-annual-schedule");
    const everyWeeks = $("#builder-every-weeks-schedule");
    const everyMonths = $("#builder-every-months-schedule");
    const daily = $("#builder-daily-schedule");
    const workdays = $("#builder-workdays-schedule");
    if (!weekly || !monthly || !annual || !everyWeeks || !everyMonths || !daily || !workdays) return;
    const val = cadence ? cadence.value : "weekly";
    weekly.classList.toggle("hidden", val !== "weekly");
    monthly.classList.toggle("hidden", val !== "monthly");
    annual.classList.toggle("hidden", val !== "annual");
    everyWeeks.classList.toggle("hidden", val !== "everyweeks");
    everyMonths.classList.toggle("hidden", val !== "everymonths");
    daily.classList.toggle("hidden", val !== "daily");
    workdays.classList.toggle("hidden", val !== "workdays");
  }

  function handleBuilderAddTask() {
    const builderError = $("#builder-error");
    if (builderError) { builderError.textContent = ""; builderError.classList.add("hidden"); }

    const nameInput = $("#builder-task-name");
    const name = nameInput ? nameInput.value.trim() : "";
    if (!name) {
      if (builderError) { builderError.textContent = "Please enter a task name."; builderError.classList.remove("hidden"); }
      if (nameInput) nameInput.focus();
      return;
    }

    const cadenceEl = document.querySelector('input[name="builder-cadence"]:checked');
    const cadence = cadenceEl ? cadenceEl.value : "weekly";

    let schedule = "";
    if (cadence === "weekly") {
      const checked = Array.from(document.querySelectorAll('input[name="builder-weekday"]:checked')).map((cb) => cb.value);
      if (!checked.length) {
        if (builderError) { builderError.textContent = "Please select at least one day."; builderError.classList.remove("hidden"); }
        return;
      }
      schedule = checked.join(",");
    } else if (cadence === "annual") {
      const annualMonthInput = $("#builder-annual-month");
      const annualDayInput = $("#builder-annual-day");
      const month = annualMonthInput ? parseInt(annualMonthInput.value, 10) : NaN;
      const day = annualDayInput ? parseInt(annualDayInput.value.trim(), 10) : NaN;
      if (isNaN(month) || month < 1 || month > 12) {
        if (builderError) { builderError.textContent = "Please select a valid month."; builderError.classList.remove("hidden"); }
        if (annualMonthInput) annualMonthInput.focus();
        return;
      }
      if (isNaN(day) || day < 1 || day > 31) {
        if (builderError) { builderError.textContent = "Please enter a valid day of the month (1–31)."; builderError.classList.remove("hidden"); }
        if (annualDayInput) annualDayInput.focus();
        return;
      }
      const mm = String(month).padStart(2, "0");
      const dd = String(day).padStart(2, "0");
      schedule = mm + "-" + dd;
    } else if (cadence === "everyweeks") {
      const intervalInput = $("#builder-every-weeks-interval");
      const startInput = $("#builder-every-weeks-start");
      const interval = intervalInput ? parseInt(intervalInput.value.trim(), 10) : NaN;
      const start = startInput ? startInput.value.trim() : "";
      if (isNaN(interval) || interval < 1) {
        if (builderError) { builderError.textContent = "Please enter a valid interval of 1 or more weeks."; builderError.classList.remove("hidden"); }
        if (intervalInput) intervalInput.focus();
        return;
      }
      if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
        if (builderError) { builderError.textContent = "Please enter a valid start date (YYYY-MM-DD)."; builderError.classList.remove("hidden"); }
        if (startInput) startInput.focus();
        return;
      }
      return appendIntervalRule(name, "every" + interval + "weeks", start, builderError, nameInput);
    } else if (cadence === "everymonths") {
      const intervalInput = $("#builder-every-months-interval");
      const startInput = $("#builder-every-months-start");
      const interval = intervalInput ? parseInt(intervalInput.value.trim(), 10) : NaN;
      const start = startInput ? startInput.value.trim() : "";
      if (isNaN(interval) || interval < 1) {
        if (builderError) { builderError.textContent = "Please enter a valid interval of 1 or more months."; builderError.classList.remove("hidden"); }
        if (intervalInput) intervalInput.focus();
        return;
      }
      if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
        if (builderError) { builderError.textContent = "Please enter a valid start date (YYYY-MM-DD)."; builderError.classList.remove("hidden"); }
        if (startInput) startInput.focus();
        return;
      }
      return appendIntervalRule(name, "every" + interval + "months", start, builderError, nameInput);
    } else if (cadence === "daily") {
      schedule = "daily";
    } else if (cadence === "workdays") {
      schedule = "workdays";
    } else {
      const monthlyInput = $("#builder-monthly-dates");
      const raw = monthlyInput ? monthlyInput.value.trim() : "";
      if (!raw) {
        if (builderError) { builderError.textContent = "Please enter at least one day of the month."; builderError.classList.remove("hidden"); }
        if (monthlyInput) monthlyInput.focus();
        return;
      }
      const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
      const valid = parts.every((p) => /^\d+$/.test(p) && parseInt(p, 10) >= 1 && parseInt(p, 10) <= 31);
      if (!valid) {
        if (builderError) { builderError.textContent = "Day numbers must be integers between 1 and 31, separated by commas."; builderError.classList.remove("hidden"); }
        if (monthlyInput) monthlyInput.focus();
        return;
      }
      schedule = parts.join(",");
    }

    const line = name + "-" + cadence + "-" + schedule;
    const textarea = $("#config-modal-textarea");
    if (textarea) {
      const existing = textarea.value;
      textarea.value = existing ? existing.trimEnd() + "\n" + line : line;
      refreshRtdTaskNameDropdown();
    }

    resetTaskBuilder();
    if (nameInput) nameInput.focus();
  }

  function appendIntervalRule(name, frequency, start, builderError, nameInput) {
    const line = name + "-" + frequency + "-" + start;
    const textarea = $("#config-modal-textarea");
    if (textarea) {
      const existing = textarea.value;
      textarea.value = existing ? existing.trimEnd() + "\n" + line : line;
      refreshRtdTaskNameDropdown();
    }
    resetTaskBuilder();
    if (nameInput) nameInput.focus();
  }

  function handleConfigFileUpload(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (readEvent) => {
      const text = readEvent.target.result;
      const textarea = $("#config-modal-textarea");
      if (textarea) {
        textarea.value = text;
        refreshRtdTaskNameDropdown();
      }
    };
    reader.readAsText(file);
    // Reset file input so the same file can be re-uploaded if needed.
    event.target.value = "";
  }

  async function saveProjectConfig(event) {
    event.preventDefault();
    if (!configModalProjectId) return;
    if (guardOffline()) return;

    const textarea = $("#config-modal-textarea");
    const errorEl = $("#config-modal-error");
    const configText = textarea ? textarea.value : "";
    const parsedConfig = window.TaskPlannerCore.parseProjectConfigDetailed(configText);
    const rules = parsedConfig.rules;

    if (parsedConfig.errors.length) {
      if (errorEl) {
        errorEl.textContent = parsedConfig.errors
          .map((error) => "Line " + error.line + ": " + error.message)
          .join(" ");
        errorEl.classList.remove("hidden");
      }
      return;
    }

    if (errorEl) {
      errorEl.textContent = "";
      errorEl.classList.add("hidden");
    }

    const projectId = configModalProjectId;
    const saved = await runServerCommand("Saving project configuration on server...", () =>
      supabase.schema("todo").from(PROJECTS_TABLE).update({ config_text: configText }).eq("user_id", currentUser.id).eq("id", projectId)
    );
    if (!saved) return;
    closeConfigModal();
    await generateTasksForProjectsOnServer([projectId]);
  }

  async function clearProjectConfig() {
    if (!configModalProjectId) return;
    if (guardOffline()) return;
    if (!confirm("Clear the recurring configuration for this project? Existing generated tasks will remain but no new ones will be created.")) return;

    const projectId = configModalProjectId;
    const saved = await runServerCommand("Clearing project configuration on server...", () =>
      supabase.schema("todo").from(PROJECTS_TABLE).update({ config_text: "" }).eq("user_id", currentUser.id).eq("id", projectId)
    );
    if (saved) closeConfigModal();
  }

  // --- Recurring task description UI ---

  /**
   * Renders the list of task-name → description mappings for the given project
   * inside the config modal. Called whenever the modal is opened or a mapping
   * is added/removed.
   */
  function renderRecurringTaskDescriptionsList(projectId) {
    const listEl = $("#recurring-task-descriptions-list");
    if (!listEl) return;
    listEl.innerHTML = "";

    const projectDescs = recurringTaskDescriptions[projectId] || {};
    const taskNames = Object.keys(projectDescs).sort();

    if (!taskNames.length) {
      const empty = document.createElement("p");
      empty.className = "recurring-desc-empty";
      empty.textContent = "No default descriptions configured for this project.";
      listEl.appendChild(empty);
      return;
    }

    taskNames.forEach((taskName) => {
      const desc = projectDescs[taskName];
      const item = document.createElement("div");
      item.className = "recurring-desc-item";

      const nameEl = document.createElement("span");
      nameEl.className = "recurring-desc-task-name";
      nameEl.textContent = taskName;
      item.appendChild(nameEl);

      const descEl = document.createElement("span");
      descEl.className = "recurring-desc-preview";
      const firstLine = (desc || "").split("\n")[0];
      descEl.textContent = firstLine.length <= RECURRING_DESC_PREVIEW_MAX_LENGTH
        ? firstLine
        : firstLine.slice(0, RECURRING_DESC_PREVIEW_MAX_LENGTH - 3) + "...";
      item.appendChild(descEl);

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn-danger recurring-desc-delete-btn";
      deleteBtn.textContent = "Remove";
      deleteBtn.setAttribute("data-project-id", projectId);
      deleteBtn.setAttribute("data-task-name", taskName);
      deleteBtn.addEventListener("click", () => handleDeleteRecurringTaskDescription(projectId, taskName));
      item.appendChild(deleteBtn);

      listEl.appendChild(item);
    });
  }

  async function handleAddRecurringTaskDescription() {
    const projectId = configModalProjectId;
    if (!projectId) return;
    if (guardOffline()) return;

    const nameInput = $("#rtd-task-name-input");
    const descInput = $("#rtd-description-input");
    const errorEl = $("#rtd-error");

    if (errorEl) { errorEl.textContent = ""; errorEl.classList.add("hidden"); }

    const taskName = nameInput ? nameInput.value.trim() : "";
    const description = descInput ? descInput.value : "";

    if (!taskName) {
      if (errorEl) { errorEl.textContent = "Please select a task name."; errorEl.classList.remove("hidden"); }
      if (nameInput) nameInput.focus();
      return;
    }

    const saved = await runServerCommand("Saving recurring description on server...", () =>
      supabase.schema("todo").from(RECURRING_TASK_DESCRIPTIONS_TABLE).upsert({
        user_id: currentUser.id,
        project_id: projectId,
        task_name: taskName,
        description,
      }, { onConflict: "user_id,project_id,task_name" })
    );
    if (!saved) return;

    if (nameInput) nameInput.value = "";
    if (descInput) descInput.value = "";

    renderRecurringTaskDescriptionsList(projectId);
    if (nameInput) nameInput.focus();
  }

  async function handleDeleteRecurringTaskDescription(projectId, taskName) {
    if (!projectId || !taskName) return;
    if (guardOffline()) return;
    const saved = await runServerCommand("Removing recurring description from server...", () =>
      supabase
        .schema("todo")
        .from(RECURRING_TASK_DESCRIPTIONS_TABLE)
        .delete()
        .eq("user_id", currentUser.id)
        .eq("project_id", projectId)
        .eq("task_name", taskName)
    );
      if (saved) renderRecurringTaskDescriptionsList(projectId);
  }

  async function completeTask(taskId, options) {
    if (!currentProjectId) return;
    if (guardOffline()) return;
    const skipDelay = !!(options && options.skipDelay);
    const projectId = currentProjectId;
    const task = getProjectState(projectId).tasks[taskId];
    if (!task) return;
    if (!skipDelay) {
      queueTaskCompletion(taskId);
      return;
    }

    await runServerCommand("Completing task on server...", () =>
      supabase.schema("todo").rpc("complete_task", {
        p_project_id: projectId,
        p_task_id: taskId,
      })
    );
  }

  async function completeAllOverdueTasks() {
    if (!currentProjectId) return;
    if (guardOffline()) return;
    const projectId = currentProjectId;
    const overdueTaskIds = getTaskBuckets(projectId, selectedDate).overdue
      .map((task) => task.id);
    const totalOverdue = overdueTaskIds.length;
    if (!totalOverdue) return;

    if (!confirm(`Are you sure you definitely want to complete all ${totalOverdue} overdue task${totalOverdue === 1 ? "" : "s"} for this project?`)) return;

    await runServerCommand("Completing overdue tasks on server...", () =>
      supabase.schema("todo").rpc("complete_tasks", {
        p_project_id: projectId,
        p_task_ids: overdueTaskIds,
      })
    );
  }

  async function deferAllOverdueTasksToToday() {
    if (!currentProjectId) return;
    if (guardOffline()) return;
    const projectId = currentProjectId;
    const today = todayKey();
    const overdueTaskIds = getTaskBuckets(projectId, selectedDate).overdue
      .map((task) => task.id);
    const totalOverdue = overdueTaskIds.length;
    if (!totalOverdue) return;

    if (!confirm(`Are you sure you want to defer all ${totalOverdue} overdue task${totalOverdue === 1 ? "" : "s"} to today for this project?`)) return;

    await runServerCommand("Deferring overdue tasks on server...", () =>
      supabase
        .schema("todo")
        .from(TASKS_TABLE)
        .update({ due_date: today })
        .eq("user_id", currentUser.id)
        .eq("project_id", projectId)
        .in("id", overdueTaskIds)
    );
  }

  async function openEditModal(taskId) {
    const task = getActiveTask(taskId);
    if (!task) return;

    editTaskId = taskId;
    configureTaskDateInput("edit-task-date-input");
    $("#edit-task-name-input").value = task.name || "";
    $("#edit-task-description-input").value = task.description || "";
    $("#edit-task-date-input").value = task.dueDate || "";
    openModal("edit-modal", "#edit-task-name-input");

    // Fetch the authoritative long description from the cloud table.
    // Disable the textarea briefly so the user doesn't type before the
    // value arrives, then restore it and focus.
    if (currentUser && supabase) {
      const descriptionEl = $("#edit-task-description-input");
      const editingId = taskId; // captured before the await for stale-check
      descriptionEl.disabled = true;
      const cloudBody = await fetchTaskDescription(currentProjectId, taskId);
      descriptionEl.disabled = false;
      // Only overwrite if still editing the same task (modal not closed/changed)
      if (editTaskId === editingId && cloudBody !== null) {
        descriptionEl.value = cloudBody;
      }
    }
  }

  function closeEditModal() {
    editTaskId = null;
    closeModal("edit-modal");
  }

  function getDefaultAddTaskDate() {
    return selectedTaskView === "day" && isDateKey(selectedDate) ? selectedDate : "";
  }

  function populateAddTaskProjectSelect(defaultProjectId) {
    const select = $("#add-task-project-select");
    if (!select) return;
    select.innerHTML = "";
    const projects = getAllProjects();
    projects.forEach((project) => {
      const option = document.createElement("option");
      option.value = project.id;
      option.textContent = project.name;
      if (project.id === defaultProjectId) option.selected = true;
      select.appendChild(option);
    });
  }

  function openAddTaskModal(defaultProjectId) {
    const projects = getAllProjects();
    if (!projects.length) return;
    const resolvedDefaultId = defaultProjectId || currentProjectId || projects[0].id;
    if (!resolvedDefaultId) return;
    $("#add-task-name-input").value = "";
    $("#add-task-description-input").value = "";
    populateAddTaskProjectSelect(resolvedDefaultId);
    configureTaskDateInput("add-task-date-input", getDefaultAddTaskDate());
    openModal("add-task-modal", "#add-task-name-input");
  }

  function closeAddTaskModal() {
    closeModal("add-task-modal");
  }

  async function submitAddTask(event) {
    event.preventDefault();
    const added = await addManualTaskFromForm("add-task-name-input", "add-task-description-input", "add-task-date-input");
    if (!added) return;

    closeAddTaskModal();
  }

  async function saveEditedTask(event) {
    event.preventDefault();
    if (!currentProjectId || !editTaskId) return;
    if (guardOffline()) return;

    const projectId = currentProjectId;
    const task = getProjectState(projectId).tasks[editTaskId];
    if (!task) {
      closeEditModal();
      return;
    }

    const name = $("#edit-task-name-input").value.trim();
    const description = $("#edit-task-description-input").value.trim();
    const dueDateValue = $("#edit-task-date-input").value;
    const dueDate = isDateKey(dueDateValue) ? dueDateValue : null;
    if (!name) return;

    const savedTaskId = editTaskId;
    const saved = await runServerCommand("Saving task to server...", () =>
      supabase
        .schema("todo")
        .from(TASKS_TABLE)
        .update({ name, body: description, due_date: dueDate })
        .eq("user_id", currentUser.id)
        .eq("project_id", projectId)
        .eq("id", savedTaskId)
    );
    if (saved) closeEditModal();
  }

  function formatDeferDateLabel(dateKey) {
    const today = todayKey();
    const tomorrowKey = addDays(today, 1);
    let label = formatDateLong(dateKey);
    if (dateKey === today) label += " (Today)";
    else if (dateKey === tomorrowKey) label += " (Tomorrow)";
    return label;
  }

  function populateDeferButtons(task) {
    const container = $("#defer-date-buttons");
    container.innerHTML = "";

    getDeferDates(task ? task.dueDate : null).forEach((dateKey) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "defer-date-btn";
      btn.textContent = formatDeferDateLabel(dateKey);
      btn.addEventListener("click", () => {
        deferToDate(dateKey);
      });
      container.appendChild(btn);
    });
  }

  function openDeferModal(taskId) {
    if (!currentProjectId) return;
    const task = getProjectState(currentProjectId).tasks[taskId];
    if (!task) return;

    deferTaskId = taskId;
    populateDeferButtons(task);
    $("#defer-task-name").textContent = task.name;
    openModal("defer-modal", ".defer-date-btn");
  }

  function closeDeferModal() {
    deferTaskId = null;
    closeModal("defer-modal");
  }

  async function deferToDate(dateKey) {
    if (!currentProjectId || !deferTaskId) return;
    if (guardOffline()) { closeDeferModal(); return; }
    const projectId = currentProjectId;
    const taskId = deferTaskId;
    const task = getProjectState(projectId).tasks[taskId];
    if (!task) {
      closeDeferModal();
      return;
    }

    const saved = await runServerCommand("Scheduling task on server...", () =>
      supabase
        .schema("todo")
        .from(TASKS_TABLE)
        .update({ due_date: dateKey })
        .eq("user_id", currentUser.id)
        .eq("project_id", projectId)
        .eq("id", taskId)
    );
    if (saved) closeDeferModal();
  }

  async function clearDeferDate() {
    if (!currentProjectId || !deferTaskId) return;
    if (guardOffline()) { closeDeferModal(); return; }
    const projectId = currentProjectId;
    const taskId = deferTaskId;
    const task = getProjectState(projectId).tasks[taskId];
    if (!task) {
      closeDeferModal();
      return;
    }

    const saved = await runServerCommand("Clearing due date on server...", () =>
      supabase
        .schema("todo")
        .from(TASKS_TABLE)
        .update({ due_date: null })
        .eq("user_id", currentUser.id)
        .eq("project_id", projectId)
        .eq("id", taskId)
    );
    if (saved) closeDeferModal();
  }

  async function togglePinTask(taskId) {
    if (!currentProjectId) return;
    if (guardOffline()) return;
    const projectId = currentProjectId;
    const task = getProjectState(projectId).tasks[taskId];
    if (!task) return;

    const pinned = !task.pinned;
    await runServerCommand("Updating task on server...", () =>
      supabase
        .schema("todo")
        .from(TASKS_TABLE)
        .update({ pinned, end_of_day: pinned ? false : task.endOfDay })
        .eq("user_id", currentUser.id)
        .eq("project_id", projectId)
        .eq("id", taskId)
    );
  }

  async function toggleEndOfDayTask(taskId) {
    if (!currentProjectId) return;
    if (guardOffline()) return;
    const projectId = currentProjectId;
    const task = getProjectState(projectId).tasks[taskId];
    if (!task) return;

    const endOfDay = !task.endOfDay;
    await runServerCommand("Updating task on server...", () =>
      supabase
        .schema("todo")
        .from(TASKS_TABLE)
        .update({ end_of_day: endOfDay, pinned: endOfDay ? false : task.pinned })
        .eq("user_id", currentUser.id)
        .eq("project_id", projectId)
        .eq("id", taskId)
    );
  }

  async function hardDeleteTask(taskId) {
    if (!currentProjectId) return;
    if (guardOffline()) return;
    const projectId = currentProjectId;
    const task = getProjectState(projectId).tasks[taskId];
    if (!task) return;

    if (!confirm('Delete "' + task.name + '" permanently? This will not move it to the archive.')) return;

    await runServerCommand("Deleting task from server...", () =>
      supabase
        .schema("todo")
        .from(TASKS_TABLE)
        .delete()
        .eq("user_id", currentUser.id)
        .eq("project_id", projectId)
        .eq("id", taskId)
    );
  }

  async function deleteArchivedTask(taskId) {
    if (!currentProjectId) return;
    if (guardOffline()) return;
    const projectId = currentProjectId;
    const task = getProjectState(projectId).archived[taskId];
    if (!task) return;

    if (!confirm('Delete archived task "' + task.name + '"?')) return;

    await runServerCommand("Deleting archived task from server...", () =>
      supabase
        .schema("todo")
        .from(ARCHIVED_TASKS_TABLE)
        .delete()
        .eq("user_id", currentUser.id)
        .eq("project_id", projectId)
        .eq("id", taskId)
    );
  }

  async function clearArchive() {
    if (!currentProjectId) return;
    if (guardOffline()) return;
    const projectId = currentProjectId;
    const archiveIds = Object.keys(getProjectState(projectId).archived);
    if (!archiveIds.length) return;

    if (!confirm("Delete the entire archive for this project?")) return;

    await runServerCommand("Deleting archive from server...", () =>
      supabase
        .schema("todo")
        .from(ARCHIVED_TASKS_TABLE)
        .delete()
        .eq("user_id", currentUser.id)
        .eq("project_id", projectId)
    );
  }

  function downloadTextFile(filename, contents) {
    downloadFile(filename, contents, "text/plain;charset=utf-8");
  }

  function downloadFile(filename, contents, contentType) {
    const blob = new Blob([contents], { type: contentType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function downloadCsvFile(filename, contents) {
    downloadFile(filename, contents, "text/csv;charset=utf-8");
  }

  function buildCsvValue(value) {
    if (value === null || typeof value === "undefined") return "";
    const text = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
    if (!/[",\r\n]/.test(text)) return text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function buildCsvContents(columns, rows) {
    const lines = [columns.join(",")];
    rows.forEach((row) => {
      lines.push(columns.map((column) => buildCsvValue(row[column])).join(","));
    });
    return lines.join("\r\n");
  }

  // Produces an ISO-like UTC timestamp that is safe to embed in download
  // filenames, e.g. 2026-07-11-14-30-45Z.
  function generateFilenameTimestamp() {
    return nowIso().replace(/\.\d{3}Z$/, "Z").replace(/[T:]/g, "-");
  }

  function wait(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function compareBackupValues(a, b) {
    const left = a === null || typeof a === "undefined" ? "" : String(a);
    const right = b === null || typeof b === "undefined" ? "" : String(b);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  function sortBackupRows(rows, keys) {
    return rows.slice().sort((left, right) => {
      for (let index = 0; index < keys.length; index += 1) {
        const result = compareBackupValues(left[keys[index]], right[keys[index]]);
        if (result !== 0) return result;
      }
      return 0;
    });
  }

  function buildPersistenceBackupTables() {
    const normalizedState = normalizeState(appState);
    const userId = currentUser && currentUser.id ? currentUser.id : "";
    const userSettingsRow = {
      user_id: userId,
      default_project_id: normalizedState.defaultProjectId || "",
      default_project_updated_at: normalizedState.defaultProjectUpdatedAt || normalizedState.updatedAt || "",
      updated_at: normalizedState.updatedAt || "",
    };
    const tables = {
      archived_tasks: [],
      generated_occurrences: [],
      project_tombstones: [],
      project_tags: [],
      projects: [],
      recurring_task_descriptions: [],
      tags: [],
      task_tombstones: [],
      tasks: [],
      user_settings: [userSettingsRow],
    };

    Object.keys(normalizedState.projects).forEach((projectId) => {
      const project = normalizeProjectState(projectId, normalizedState.projects[projectId]);
      tables.projects.push({
        user_id: userId,
        id: projectId,
        name: project.name || "",
        inactive: !!project.inactive,
        last_generated_through: project.lastGeneratedThrough || "",
        config_text: projectConfigTexts[projectId] || "",
        updated_at: project.updatedAt || normalizedState.updatedAt || "",
      });

      normalizeTagList(project.tags).forEach((tag) => {
        tables.tags.push({
          user_id: userId,
          tag,
        });
        tables.project_tags.push({
          user_id: userId,
          project_id: projectId,
          tag,
        });
      });

      Object.keys(project.tasks || {}).forEach((taskId) => {
        const task = project.tasks[taskId];
        const taskDescription = typeof task.description === "string" ? task.description : "";
        tables.tasks.push({
          user_id: userId,
          project_id: projectId,
          id: task.id || taskId,
          name: task.name || "",
          due_date: task.dueDate || "",
          source: task.source === "generated" ? "generated" : "manual",
          generated_key: task.generatedKey || "",
          pinned: !!task.pinned,
          end_of_day: !!task.endOfDay,
          body: taskDescription,
          created_at: task.createdAt || task.updatedAt || "",
          updated_at: task.updatedAt || "",
        });
      });

      Object.keys(project.archived || {}).forEach((taskId) => {
        const task = project.archived[taskId];
        tables.archived_tasks.push({
          user_id: userId,
          project_id: projectId,
          id: task.id || taskId,
          name: task.name || "",
          due_date: task.dueDate || "",
          source: task.source === "generated" ? "generated" : "manual",
          generated_key: task.generatedKey || "",
          pinned: !!task.pinned,
          end_of_day: !!task.endOfDay,
          completed_at: task.completedAt || "",
          created_at: task.createdAt || task.updatedAt || "",
          updated_at: task.updatedAt || "",
        });
      });

      Object.keys(project.generatedOccurrences || {}).forEach((occurrenceKey) => {
        const occurrence = project.generatedOccurrences[occurrenceKey];
        tables.generated_occurrences.push({
          user_id: userId,
          project_id: projectId,
          occurrence_key: occurrenceKey,
          task_id: occurrence.taskId || "",
          due_date: occurrence.dueDate || "",
          task_name: occurrence.taskName || "",
          created_at: occurrence.createdAt || "",
        });
      });

      Object.keys(project.deletedTasks || {}).forEach((taskId) => {
        tables.task_tombstones.push({
          user_id: userId,
          project_id: projectId,
          task_id: taskId,
          is_archived: false,
          deleted_at: project.deletedTasks[taskId] || "",
        });
      });

      Object.keys(project.deletedArchivedTasks || {}).forEach((taskId) => {
        tables.task_tombstones.push({
          user_id: userId,
          project_id: projectId,
          task_id: taskId,
          is_archived: true,
          deleted_at: project.deletedArchivedTasks[taskId] || "",
        });
      });
    });

    Object.keys(normalizedState.deletedProjects || {}).forEach((projectId) => {
      tables.project_tombstones.push({
        user_id: userId,
        project_id: projectId,
        deleted_at: normalizedState.deletedProjects[projectId] || "",
      });
    });

    Object.keys(recurringTaskDescriptions).forEach((projectId) => {
      const projectDescriptions = recurringTaskDescriptions[projectId];
      if (!projectDescriptions || typeof projectDescriptions !== "object") return;
      Object.keys(projectDescriptions).forEach((taskName) => {
        tables.recurring_task_descriptions.push({
          user_id: userId,
          project_id: projectId,
          task_name: taskName,
          description: typeof projectDescriptions[taskName] === "string" ? projectDescriptions[taskName] : "",
        });
      });
    });

    tables.tags = sortBackupRows(
      Array.from(new Map(tables.tags.map((row) => [row.tag, row])).values()),
      ["tag"]
    );

    return [
      {
        tableName: "archived_tasks",
        columns: ["user_id", "project_id", "id", "name", "due_date", "source", "generated_key", "pinned", "end_of_day", "completed_at", "created_at", "updated_at"],
        rows: sortBackupRows(tables.archived_tasks, ["project_id", "id"]),
      },
      {
        tableName: "generated_occurrences",
        columns: ["user_id", "project_id", "occurrence_key", "task_id", "due_date", "task_name", "created_at"],
        rows: sortBackupRows(tables.generated_occurrences, ["project_id", "occurrence_key"]),
      },
      {
        tableName: "project_tombstones",
        columns: ["user_id", "project_id", "deleted_at"],
        rows: sortBackupRows(tables.project_tombstones, ["project_id"]),
      },
      {
        tableName: "project_tags",
        columns: ["user_id", "project_id", "tag"],
        rows: sortBackupRows(tables.project_tags, ["project_id", "tag"]),
      },
      {
        tableName: "projects",
        columns: ["user_id", "id", "name", "inactive", "last_generated_through", "config_text", "updated_at"],
        rows: sortBackupRows(tables.projects, ["id"]),
      },
      {
        tableName: "recurring_task_descriptions",
        columns: ["user_id", "project_id", "task_name", "description"],
        rows: sortBackupRows(tables.recurring_task_descriptions, ["project_id", "task_name"]),
      },
      {
        tableName: "tags",
        columns: ["user_id", "tag"],
        rows: tables.tags,
      },
      {
        tableName: "task_tombstones",
        columns: ["user_id", "project_id", "task_id", "is_archived", "deleted_at"],
        rows: sortBackupRows(tables.task_tombstones, ["project_id", "task_id", "is_archived"]),
      },
      {
        tableName: "tasks",
        columns: ["user_id", "project_id", "id", "name", "due_date", "source", "generated_key", "pinned", "end_of_day", "body", "created_at", "updated_at"],
        rows: sortBackupRows(tables.tasks, ["project_id", "id"]),
      },
      {
        tableName: "user_settings",
        columns: ["user_id", "default_project_id", "default_project_updated_at", "updated_at"],
        rows: tables.user_settings,
      },
    ];
  }

  async function downloadPersistenceBackup() {
    const timestamp = generateFilenameTimestamp();
    const tableBackups = buildPersistenceBackupTables();
    for (let index = 0; index < tableBackups.length; index += 1) {
      const tableBackup = tableBackups[index];
      downloadCsvFile(
        "todo-backup-" + timestamp + "-" + tableBackup.tableName + ".csv",
        buildCsvContents(tableBackup.columns, tableBackup.rows)
      );
      if (index < tableBackups.length - 1) {
        // Small gap helps browsers treat this as a user-initiated download burst.
        await wait(BACKUP_DOWNLOAD_DELAY_MS);
      }
    }
  }

  function buildTaskExport(projectId, archived) {
    const project = getProjectMeta(projectId);
    const title = project ? project.name : projectId;
    const tasks = archived ? sortArchivedTasks(getProjectArchivedTasks(projectId)) : sortActiveTasks(getProjectTasks(projectId));

    const lines = [];
    lines.push("Project: " + title);
    lines.push("Exported: " + new Date().toLocaleString());
    lines.push("Mode: " + (archived ? "Archive" : "Active tasks"));
    lines.push("");

    if (!tasks.length) {
      lines.push("No tasks.");
      return lines.join("\n");
    }

    tasks.forEach((task) => {
      lines.push(task.name);
      lines.push("  Source: " + (task.source === "generated" ? "Recurring" : "Manual"));
      lines.push("  Due: " + (task.dueDate ? task.dueDate : "No due date"));
      if (archived && task.completedAt) {
        lines.push("  Completed: " + task.completedAt);
      }
      if (task.description) {
        lines.push("  Description: " + task.description.replace(/\r?\n/g, " "));
      }
      lines.push("");
    });

    return lines.join("\n");
  }

  function downloadActiveTasks() {
    if (!currentProjectId) return;
    const project = getProjectMeta(currentProjectId);
    const name = project ? project.name : currentProjectId;
    downloadTextFile(name + " Active Tasks.txt", buildTaskExport(currentProjectId, false));
  }

  function downloadArchiveTasks() {
    if (!currentProjectId) return;
    const project = getProjectMeta(currentProjectId);
    const name = project ? project.name : currentProjectId;
    downloadTextFile(name + " Archive.txt", buildTaskExport(currentProjectId, true));
  }

  function downloadAllArchivedTasks() {
    const allProjects = [...getAllProjects(), ...getInactiveProjects()];
    const lines = [];
    lines.push("All Archived Tasks");
    lines.push("Exported: " + new Date().toLocaleString());
    lines.push("");

    allProjects.forEach((project) => {
      const archivedTasks = sortArchivedTasks(getProjectArchivedTasks(project.id));
      if (!archivedTasks.length) return;
      lines.push("=== " + project.name + " ===");
      archivedTasks.forEach((task) => {
        lines.push(task.name);
        lines.push("  Source: " + (task.source === "generated" ? "Recurring" : "Manual"));
        lines.push("  Due: " + (task.dueDate ? task.dueDate : "No due date"));
        if (task.completedAt) {
          lines.push("  Completed: " + task.completedAt);
        }
        if (task.description) {
          lines.push("  Description: " + task.description.replace(/\r?\n/g, " "));
        }
        lines.push("");
      });
    });

    downloadTextFile("All Archived Tasks.txt", lines.join("\n"));

    const deleteBtn = $("#delete-all-archives-btn");
    if (deleteBtn) deleteBtn.disabled = false;
  }

  async function deleteAllArchivedTasks() {
    if (guardOffline()) return;
    const allProjects = [...getAllProjects(), ...getInactiveProjects()];
    const projectArchives = allProjects.map((project) => ({
      project,
      archiveIds: Object.keys(getProjectState(project.id).archived || {}),
    }));
    const totalArchived = projectArchives.reduce((sum, entry) => sum + entry.archiveIds.length, 0);
    if (!totalArchived) return;

    if (!confirm("Delete " + totalArchived + " archived task" + (totalArchived === 1 ? "" : "s") + " across all projects?")) return;

    await runServerCommand("Deleting archived tasks from server...", () =>
      supabase.schema("todo").from(ARCHIVED_TASKS_TABLE).delete().eq("user_id", currentUser.id)
    );
  }

  async function refreshCurrentProject() {
    if (!currentProjectId) return;
    const project = getProjectMeta(currentProjectId);
    if (!project || !project.hasConfig) {
      setSyncStatus("This project has no recurring config file to refresh.");
      return;
    }
    await generateTasksForProjectsOnServer([currentProjectId]);
  }

  async function refreshAllProjects() {
    await generateTasksForProjectsOnServer(Object.keys(projectConfigs));
  }

  function bindAuthEvents() {
    $$(".auth-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        $$(".auth-tab").forEach((item) => item.classList.remove("active"));
        tab.classList.add("active");
        const isSignup = tab.dataset.tab === "signup";
        $("#auth-submit-btn").textContent = isSignup ? "Sign Up" : "Sign In";
        $("#auth-password").setAttribute("autocomplete", isSignup ? "new-password" : "current-password");
        $("#auth-error").classList.add("hidden");
      });
    });

    $("#auth-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = $("#auth-email").value.trim();
      const password = $("#auth-password").value;
      const isSignup = $(".auth-tab.active").dataset.tab === "signup";
      const errorEl = $("#auth-error");
      const submitButton = $("#auth-submit-btn");

      errorEl.classList.add("hidden");
      submitButton.disabled = true;
      submitButton.textContent = isSignup ? "Signing up..." : "Signing in...";

      try {
        let result;
        if (isSignup) {
          result = await supabase.auth.signUp({ email, password });
        } else {
          result = await supabase.auth.signInWithPassword({ email, password });
        }

        if (result.error) {
          errorEl.textContent = result.error.message;
          errorEl.classList.remove("hidden");
        } else if (isSignup && result.data && result.data.user && !result.data.session) {
          errorEl.textContent = "Check your email for a confirmation link.";
          errorEl.classList.remove("hidden");
        }
      } catch (error) {
        errorEl.textContent = "Network error. Please try again.";
        errorEl.classList.remove("hidden");
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = isSignup ? "Sign Up" : "Sign In";
      }
    });

  }

  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;
    document.addEventListener("keydown", handleModalKeydown);

    $("#generate-all-btn").addEventListener("click", refreshAllProjects);
    $("#toggle-project-actions-btn").addEventListener("click", () => {
      showProjectActions = !showProjectActions;
      renderHome();
    });
    $("#open-create-project-btn").addEventListener("click", openCreateProjectPanel);
    $("#cancel-create-project-btn").addEventListener("click", closeCreateProjectPanel);
    $("#view-inactive-btn").addEventListener("click", openInactiveProjects);
    $("#open-home-add-task-btn").addEventListener("click", () => {
      openAddTaskModal(null);
    });
    $("#download-persistence-backup-btn").addEventListener("click", downloadPersistenceBackup);
    $("#download-all-archives-btn").addEventListener("click", downloadAllArchivedTasks);
    $("#delete-all-archives-btn").addEventListener("click", deleteAllArchivedTasks);
    $("#back-from-inactive-btn").addEventListener("click", () => {
      renderHome();
      showScreen("home");
    });
    $("#back-home-btn").addEventListener("click", () => {
      currentProjectId = null;
      renderHome();
      showScreen("home");
    });
    $("#open-project-add-task-btn").addEventListener("click", () => {
      openAddTaskModal();
    });
    $("#back-project-from-day-btn").addEventListener("click", () => {
      renderProject();
    });
    $("#home-from-day-btn").addEventListener("click", () => {
      currentProjectId = null;
      renderHome();
      showScreen("home");
    });
    $("#open-day-add-task-btn").addEventListener("click", () => {
      openAddTaskModal();
    });
    $("#all-tasks-view-btn").addEventListener("click", openAllTasks);
    $("#refresh-project-btn").addEventListener("click", refreshCurrentProject);
    $("#refresh-day-project-btn").addEventListener("click", refreshCurrentProject);
    $("#open-project-configure-btn").addEventListener("click", () => {
      if (currentProjectId) openConfigModal(currentProjectId);
    });
    $("#download-active-btn").addEventListener("click", downloadActiveTasks);
    $("#view-archive-btn").addEventListener("click", openArchive);
    $("#back-project-btn").addEventListener("click", () => {
      renderDayView();
    });
    $("#home-from-archive-btn").addEventListener("click", () => {
      currentProjectId = null;
      renderHome();
      showScreen("home");
    });
    $("#download-archive-btn").addEventListener("click", downloadArchiveTasks);
    $("#delete-archive-btn").addEventListener("click", clearArchive);
    $("#create-project-form").addEventListener("submit", createManualProject);
    $("#cancel-add-task-btn").addEventListener("click", closeAddTaskModal);
    $("#add-task-form").addEventListener("submit", submitAddTask);
    $("#cancel-defer-btn").addEventListener("click", closeDeferModal);
    $("#clear-due-date-btn").addEventListener("click", clearDeferDate);
    $("#cancel-edit-btn").addEventListener("click", closeEditModal);
    $("#edit-task-form").addEventListener("submit", saveEditedTask);
    $("#cancel-config-btn").addEventListener("click", closeConfigModal);
    $("#config-form").addEventListener("submit", saveProjectConfig);
    $("#clear-config-btn").addEventListener("click", clearProjectConfig);
    $("#config-file-input").addEventListener("change", handleConfigFileUpload);
    $("#config-modal-textarea").addEventListener("input", refreshRtdTaskNameDropdown);
    document.querySelectorAll('input[name="builder-cadence"]').forEach((radio) => {
      radio.addEventListener("change", updateBuilderScheduleVisibility);
    });
    $("#builder-add-btn").addEventListener("click", handleBuilderAddTask);
    $("#rtd-task-name-input").addEventListener("change", () => {
      const taskName = $("#rtd-task-name-input").value;
      const descInput = $("#rtd-description-input");
      if (!descInput) return;
      const projectDescs = recurringTaskDescriptions[configModalProjectId] || {};
      descInput.value = taskName && projectDescs[taskName] !== undefined ? projectDescs[taskName] : "";
    });
    $("#rtd-add-btn").addEventListener("click", handleAddRecurringTaskDescription);
    $("#config-modal").addEventListener("click", (event) => {
      if (event.target === $("#config-modal")) {
        closeConfigModal();
      }
    });

    document.querySelectorAll(".date-quick-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = btn.dataset.target;
        const action = btn.dataset.action;
        const input = document.getElementById(targetId);
        if (!input) return;
        if (action === "clear") {
          input.value = "";
        } else if (action === "today") {
          input.value = todayKey();
        } else if (action === "tomorrow") {
          input.value = addDays(todayKey(), 1);
        } else if (action === "in7days") {
          input.value = addDays(todayKey(), 7);
        }
      });
    });
    $("#add-task-modal").addEventListener("click", (event) => {
      if (event.target === $("#add-task-modal")) {
        closeAddTaskModal();
      }
    });
    $("#defer-modal").addEventListener("click", (event) => {
      if (event.target === $("#defer-modal")) {
        closeDeferModal();
      }
    });
    $("#edit-modal").addEventListener("click", (event) => {
      if (event.target === $("#edit-modal")) {
        closeEditModal();
      }
    });

    $("#sync-now-btn").addEventListener("click", async () => {
      $("#sync-now-btn").disabled = true;
      await syncNow();
      $("#sync-now-btn").disabled = false;
    });

    $("#logout-btn").addEventListener("click", async () => {
      const signedOutUserId = currentUser && currentUser.id;
      if (supabase) {
        await supabase.auth.signOut();
      }
      clearAllLocalPersistence(signedOutUserId);
      currentUser = null;
      resetSyncTracking();
      appEntered = false;
      currentProjectId = null;
      showScreen("auth");
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && currentUser && appEntered && Date.now() - lastPullAt > 1000) {
        syncNow();
      }
    });
    window.addEventListener("focus", () => {
      if (currentUser && appEntered && Date.now() - lastPullAt > 1000) {
        syncNow();
      }
    });

    window.addEventListener("offline", () => {
      appMode = "offline-readonly";
      updateOfflineBanner();
      renderCurrentScreen();
      setSyncStatus("You are offline. Read-only mode until reconnected.");
    });

    window.addEventListener("online", async () => {
      appMode = "loading";
      updateOfflineBanner();
      setSyncStatus("Back online. Refreshing from server…");
      if (currentUser && appEntered) {
        const pulled = await pullState();
        if (pulled) {
          await fetchAllProjectConfigsFromDb();
          await fetchAllRecurringTaskDescriptionsFromDb();
          rebuildProjectConfigs();
          await generateTasksForProjectsOnServer(Object.keys(projectConfigs));
          renderCurrentScreen();
          setSyncStatus("Refreshed from server.");
        } else {
          renderCurrentScreen();
          setSyncStatus("Could not refresh from server.");
        }
      }
    });
  }

  async function enterApp() {
    if (appEntered) {
      return;
    }

    if (!currentUser) {
      showScreen("auth");
      return;
    }

    appEntered = true;
    loadProjectTagFilters();

    let serverLoaded = false;
    if (hasNetworkConnection()) {
      appMode = "loading";
      serverLoaded = await pullState();
    }

    if (serverLoaded) {
      projectConfigTexts = {};
      recurringTaskDescriptions = {};
      await fetchAllProjectConfigsFromDb();
      await fetchAllRecurringTaskDescriptionsFromDb();
    } else if (!hasNetworkConnection() || appMode === "offline-readonly") {
      appMode = "offline-readonly";
      loadLocalState();
      loadLocalProjectConfigs();
      loadLocalRecurringTaskDescriptions();
    } else {
      appState = createEmptyState();
      projectConfigTexts = {};
      recurringTaskDescriptions = {};
      setSyncStatus("Could not load current server data.");
      const detail = getUserFacingServerError(lastPullErrorMessage);
      showToast(detail ? `Could not load current server data: ${detail}` : "Could not load current server data.");
    }
    rebuildProjectConfigs();

    if (isOnline()) {
      await generateTasksForProjectsOnServer(Object.keys(projectConfigs));
    }

    showUserBar();
    updateOfflineBanner();

    const defaultId = appState.defaultProjectId;
    if (defaultId && getProjectMeta(defaultId)) {
      currentProjectId = defaultId;
      renderHome();
      openDay(todayKey());
    } else {
      renderHome();
      showScreen("home");
    }

  }

  async function init() {
    bindEvents();

    if (supabase) {
      bindAuthEvents();
      supabase.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_IN" && session && session.user) {
          currentUser = session.user;
          enterApp();
        } else if (event === "SIGNED_OUT") {
          currentUser = null;
          resetSyncTracking();
          appEntered = false;
          currentProjectId = null;
          showScreen("auth");
        }
      });

      const sessionResponse = await supabase.auth.getSession();
      if (appEntered) {
        return;
      }
      if (sessionResponse.data && sessionResponse.data.session && sessionResponse.data.session.user) {
        currentUser = sessionResponse.data.session.user;
        await enterApp();
      } else {
        showScreen("auth");
      }
      return;
    }

    await enterApp();
  }

  fetch("./manifest.json")
    .then((r) => r.json())
    .then((data) => {
      const el = document.getElementById("build-version");
      if (el && data.buildTime) {
        const d = new Date(data.buildTime);
        el.textContent = "build\u00a0" + d.toISOString().slice(0, 19).replace("T", "\u00a0") + "Z";
      }
    })
    .catch(() => {});

  init();
})();
