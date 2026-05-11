(function () {
  "use strict";

  const STORAGE_KEY = "task_planner_state_v1";
  const PROJECT_CONFIGS_STORAGE_KEY = "task_planner_project_configs_v1";
  const HIDDEN_PROJECTS_STORAGE_KEY = "task_planner_hidden_projects_v1";
  const USER_SETTINGS_TABLE = "user_settings";
  const PROJECTS_TABLE = "projects";
  const TASKS_TABLE = "tasks";
  const ARCHIVED_TASKS_TABLE = "archived_tasks";
  const GENERATED_OCCURRENCES_TABLE = "generated_occurrences";
  const TASK_TOMBSTONES_TABLE = "task_tombstones";
  const SAVE_DELAY_MS = 2000;
  const COMPLETE_DELAY_MS = 2000;
  const TOAST_DISPLAY_MS = 4000;
  const SERVER_ERROR_TOAST_COOLDOWN_MS = 15000;
  const SUPABASE_PLACEHOLDER = "https://YOUR_PROJECT_REF.supabase.co";
  const TASK_LINE = /^\s*(.+?)\s*-\s*(weekly|monthly|annual|every\d+weeks|every\d+months)\s*-\s*(.+?)\s*$/i;
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
  let syncInFlight = false;
  let saveTimer = null;
  let currentProjectId = null;
  let selectedDate = todayKey();
  let selectedTaskView = "day";
  let condensedMode = true;
  let expandedTaskCards = {};
  let deferTaskId = null;
  let editTaskId = null;
  let pendingTaskCompletions = {};
  let configModalProjectId = null;

  let projectConfigs = {};
  let projectConfigTexts = {};
  let hiddenProjectIds = new Set();
  let showHiddenProjects = false;
  let showProjectActions = false;
  let appState = createEmptyState();
  let lastServerErrorToastAt = 0;

  function nowIso() {
    return new Date().toISOString();
  }

  function createEmptyState() {
    const timestamp = nowIso();
    return {
      version: 1,
      updatedAt: timestamp,
      projects: {},
      defaultProjectId: null,
      defaultProjectUpdatedAt: timestamp,
    };
  }

  function createEmptyProjectState(projectId, name) {
    return {
      projectId,
      name: name || "",
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

  function buildPendingTaskCompletionKey(projectId, taskId) {
    return projectId + "::" + taskId;
  }

  function getPendingTaskCompletion(projectId, taskId) {
    if (!projectId || !taskId) return null;
    return pendingTaskCompletions[buildPendingTaskCompletionKey(projectId, taskId)] || null;
  }

  function clearPendingTaskCompletion(projectId, taskId) {
    const pendingKey = buildPendingTaskCompletionKey(projectId, taskId);
    const pending = pendingTaskCompletions[pendingKey];
    if (!pending) return null;
    clearTimeout(pending.timeoutId);
    delete pendingTaskCompletions[pendingKey];
    return pending;
  }

  function clearAllPendingTaskCompletions() {
    Object.keys(pendingTaskCompletions).forEach((pendingKey) => {
      clearTimeout(pendingTaskCompletions[pendingKey].timeoutId);
    });
    pendingTaskCompletions = {};
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

  function normalizeProjectState(projectId, rawProject) {
    if (!isPlainObject(rawProject)) {
      return createEmptyProjectState(projectId, "");
    }

    return {
      projectId,
      name: typeof rawProject.name === "string" ? rawProject.name : "",
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

  function mergeTimestampMaps(localMap, remoteMap) {
    const merged = {};
    const keys = new Set(Object.keys(localMap || {}).concat(Object.keys(remoteMap || {})));
    keys.forEach((key) => {
      const localValue = localMap ? localMap[key] : null;
      const remoteValue = remoteMap ? remoteMap[key] : null;
      merged[key] = laterIso(localValue, remoteValue);
    });
    return merged;
  }

  function mergeGeneratedOccurrences(localMap, remoteMap) {
    const merged = {};
    const keys = new Set(Object.keys(localMap || {}).concat(Object.keys(remoteMap || {})));

    keys.forEach((key) => {
      const localEntry = localMap ? localMap[key] : null;
      const remoteEntry = remoteMap ? remoteMap[key] : null;
      if (!localEntry) {
        merged[key] = remoteEntry;
        return;
      }
      if (!remoteEntry) {
        merged[key] = localEntry;
        return;
      }

      merged[key] = {
        createdAt: compareIso(localEntry.createdAt, remoteEntry.createdAt) <= 0 ? localEntry.createdAt : remoteEntry.createdAt,
        taskId: localEntry.taskId || remoteEntry.taskId || null,
        dueDate: localEntry.dueDate || remoteEntry.dueDate || null,
        taskName: localEntry.taskName || remoteEntry.taskName || "",
      };
    });

    return merged;
  }

  function mergeEntityMaps(localMap, remoteMap, tombstones) {
    const merged = {};
    const ids = new Set(Object.keys(localMap || {}).concat(Object.keys(remoteMap || {})));

    ids.forEach((id) => {
      const localEntity = localMap ? localMap[id] : null;
      const remoteEntity = remoteMap ? remoteMap[id] : null;
      const winningEntity = !localEntity
        ? remoteEntity
        : !remoteEntity
          ? localEntity
          : compareIso(localEntity.updatedAt, remoteEntity.updatedAt) >= 0
            ? localEntity
            : remoteEntity;

      if (!winningEntity) return;
      const deletionTime = tombstones ? tombstones[id] : null;
      if (deletionTime && compareIso(deletionTime, winningEntity.updatedAt) >= 0) return;
      merged[id] = winningEntity;
    });

    return merged;
  }

  function reconcileTaskCompletionConflicts(tasks, archived, deletedTasks, deletedArchivedTasks) {
    const mergedTasks = { ...(tasks || {}) };
    const mergedArchived = { ...(archived || {}) };
    const mergedDeletedTasks = { ...(deletedTasks || {}) };
    const mergedDeletedArchivedTasks = { ...(deletedArchivedTasks || {}) };

    Object.keys(mergedArchived).forEach((taskId) => {
      const activeTask = mergedTasks[taskId];
      const archivedTask = mergedArchived[taskId];
      if (!activeTask || !archivedTask) return;

      const activeUpdatedAt = activeTask.updatedAt;
      const archivedTransitionAt = archivedTask.completedAt || archivedTask.updatedAt;

      if (compareIso(archivedTransitionAt, activeUpdatedAt) >= 0) {
        delete mergedTasks[taskId];
        mergedDeletedTasks[taskId] = laterIso(mergedDeletedTasks[taskId], archivedTransitionAt);
      } else {
        delete mergedArchived[taskId];
        mergedDeletedArchivedTasks[taskId] = laterIso(mergedDeletedArchivedTasks[taskId], activeUpdatedAt);
      }
    });

    return {
      tasks: mergedTasks,
      archived: mergedArchived,
      deletedTasks: mergedDeletedTasks,
      deletedArchivedTasks: mergedDeletedArchivedTasks,
    };
  }

  function mergeProjectStates(projectId, localProject, remoteProject) {
    if (!localProject) return normalizeProjectState(projectId, remoteProject);
    if (!remoteProject) return normalizeProjectState(projectId, localProject);

    const normalizedLocal = normalizeProjectState(projectId, localProject);
    const normalizedRemote = normalizeProjectState(projectId, remoteProject);

    const mergedDeletedTasks = mergeTimestampMaps(normalizedLocal.deletedTasks, normalizedRemote.deletedTasks);
    const mergedDeletedArchivedTasks = mergeTimestampMaps(normalizedLocal.deletedArchivedTasks, normalizedRemote.deletedArchivedTasks);
    const mergedTasks = mergeEntityMaps(normalizedLocal.tasks, normalizedRemote.tasks, mergedDeletedTasks);
    const mergedArchivedTasks = mergeEntityMaps(normalizedLocal.archived, normalizedRemote.archived, mergedDeletedArchivedTasks);
    const completionReconciled = reconcileTaskCompletionConflicts(
      mergedTasks,
      mergedArchivedTasks,
      mergedDeletedTasks,
      mergedDeletedArchivedTasks
    );

    return {
      projectId,
      name: normalizedRemote.name || normalizedLocal.name || "",
      inactive: compareIso(normalizedLocal.updatedAt, normalizedRemote.updatedAt) >= 0 ? !!normalizedLocal.inactive : !!normalizedRemote.inactive,
      tasks: completionReconciled.tasks,
      archived: completionReconciled.archived,
      generatedOccurrences: mergeGeneratedOccurrences(normalizedLocal.generatedOccurrences, normalizedRemote.generatedOccurrences),
      lastGeneratedThrough: maxDateKey(normalizedLocal.lastGeneratedThrough, normalizedRemote.lastGeneratedThrough),
      updatedAt: laterIso(normalizedLocal.updatedAt, normalizedRemote.updatedAt),
      deletedTasks: completionReconciled.deletedTasks,
      deletedArchivedTasks: completionReconciled.deletedArchivedTasks,
    };
  }

  function mergeStates(localState, remoteState) {
    const local = normalizeState(localState);
    const remote = normalizeState(remoteState);
    const merged = createEmptyState();
    const projectIds = new Set(Object.keys(local.projects).concat(Object.keys(remote.projects)));
    const localDefaultUpdatedAt = local.defaultProjectUpdatedAt || local.updatedAt;
    const remoteDefaultUpdatedAt = remote.defaultProjectUpdatedAt || remote.updatedAt;

    projectIds.forEach((projectId) => {
      const localProject = local.projects[projectId];
      const remoteProject = remote.projects[projectId];
      merged.projects[projectId] = mergeProjectStates(projectId, localProject, remoteProject);
    });

    merged.updatedAt = laterIso(local.updatedAt, remote.updatedAt);
    if (compareIso(localDefaultUpdatedAt, remoteDefaultUpdatedAt) >= 0) {
      merged.defaultProjectId = local.defaultProjectId;
      merged.defaultProjectUpdatedAt = localDefaultUpdatedAt;
    } else {
      merged.defaultProjectId = remote.defaultProjectId;
      merged.defaultProjectUpdatedAt = remoteDefaultUpdatedAt;
    }
    return normalizeState(merged);
  }

  function loadLocalState() {
    clearAllPendingTaskCompletions();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      appState = raw ? normalizeState(JSON.parse(raw)) : createEmptyState();
    } catch (error) {
      console.warn("Failed to load local task state:", error);
      appState = createEmptyState();
    }
  }

  function saveStateLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    } catch (error) {
      console.warn("Failed to save local task state:", error);
    }
  }

  function loadHiddenProjects() {
    try {
      const raw = localStorage.getItem(HIDDEN_PROJECTS_STORAGE_KEY);
      hiddenProjectIds = raw ? new Set(JSON.parse(raw)) : new Set();
    } catch (error) {
      console.warn("Failed to load hidden projects:", error);
      hiddenProjectIds = new Set();
    }
  }

  function saveHiddenProjects() {
    try {
      localStorage.setItem(HIDDEN_PROJECTS_STORAGE_KEY, JSON.stringify(Array.from(hiddenProjectIds)));
    } catch (error) {
      console.warn("Failed to save hidden projects:", error);
    }
  }

  function hideProject(projectId) {
    hiddenProjectIds.add(projectId);
    saveHiddenProjects();
    renderHome();
  }

  function unhideProject(projectId) {
    hiddenProjectIds.delete(projectId);
    saveHiddenProjects();
    renderHome();
  }

  function touchProject(projectState, timestamp) {
    const nextTimestamp = timestamp || nowIso();
    projectState.updatedAt = nextTimestamp;
    appState.updatedAt = nextTimestamp;
  }

  function schedulePersist(message) {
    clearTimeout(saveTimer);
    if (message) setSyncStatus(message);
    saveTimer = setTimeout(() => {
      persistState();
    }, SAVE_DELAY_MS);
  }

  async function persistState() {
    clearTimeout(saveTimer);
    saveTimer = null;
    saveStateLocal();

    if (currentUser) {
      const pushed = await pushState();
      if (pushed) {
        setSyncStatus("Saved and synced.");
      } else {
        setSyncStatus("Saved locally. Cloud sync will retry later.");
      }
      return;
    }

    setSyncStatus(supabase ? "Saved locally. Sign in to sync." : "Saved locally.");
  }

  function flushLocalState() {
    clearTimeout(saveTimer);
    saveTimer = null;
    saveStateLocal();
  }

  function buildNormalizedRowsFromState(state) {
    const normalizedState = normalizeState(state);
    const userId = currentUser ? currentUser.id : null;
    if (!userId) {
      return {
        userSettings: null,
        projects: [],
        tasks: [],
        archivedTasks: [],
        generatedOccurrences: [],
      };
    }

    const rows = {
      userSettings: {
        user_id: userId,
        default_project_id: normalizedState.defaultProjectId,
        default_project_updated_at: normalizedState.defaultProjectUpdatedAt || normalizedState.updatedAt || nowIso(),
        updated_at: normalizedState.updatedAt || nowIso(),
      },
      projects: [],
      tasks: [],
      archivedTasks: [],
      generatedOccurrences: [],
      tombstones: [],
    };

    Object.keys(normalizedState.projects).forEach((projectId) => {
      const project = normalizeProjectState(projectId, normalizedState.projects[projectId]);

      rows.projects.push({
        user_id: userId,
        id: projectId,
        name: project.name || "",
        inactive: !!project.inactive,
        last_generated_through: project.lastGeneratedThrough,
        updated_at: project.updatedAt || normalizedState.updatedAt || nowIso(),
      });

      Object.keys(project.tasks || {}).forEach((taskId) => {
        const task = project.tasks[taskId];
        rows.tasks.push({
          user_id: userId,
          project_id: projectId,
          id: task.id,
          name: task.name || "",
          due_date: task.dueDate,
          source: task.source === "generated" ? "generated" : "manual",
          generated_key: task.generatedKey || null,
          pinned: !!task.pinned,
          end_of_day: !!task.endOfDay,
          created_at: task.createdAt || task.updatedAt || nowIso(),
          updated_at: task.updatedAt || nowIso(),
        });
      });

      Object.keys(project.archived || {}).forEach((taskId) => {
        const task = project.archived[taskId];
        rows.archivedTasks.push({
          user_id: userId,
          project_id: projectId,
          id: task.id,
          name: task.name || "",
          due_date: task.dueDate,
          source: task.source === "generated" ? "generated" : "manual",
          generated_key: task.generatedKey || null,
          pinned: !!task.pinned,
          end_of_day: !!task.endOfDay,
          completed_at: task.completedAt || null,
          created_at: task.createdAt || task.updatedAt || nowIso(),
          updated_at: task.updatedAt || nowIso(),
        });
      });

      Object.keys(project.generatedOccurrences || {}).forEach((occurrenceKey) => {
        const occurrence = project.generatedOccurrences[occurrenceKey];
        rows.generatedOccurrences.push({
          user_id: userId,
          project_id: projectId,
          occurrence_key: occurrenceKey,
          task_id: occurrence.taskId || null,
          due_date: occurrence.dueDate || null,
          task_name: occurrence.taskName || "",
          created_at: occurrence.createdAt || nowIso(),
        });
      });

      Object.keys(project.deletedTasks || {}).forEach((taskId) => {
        rows.tombstones.push({
          user_id: userId,
          project_id: projectId,
          task_id: taskId,
          is_archived: false,
          deleted_at: project.deletedTasks[taskId],
        });
      });

      Object.keys(project.deletedArchivedTasks || {}).forEach((taskId) => {
        rows.tombstones.push({
          user_id: userId,
          project_id: projectId,
          task_id: taskId,
          is_archived: true,
          deleted_at: project.deletedArchivedTasks[taskId],
        });
      });
    });

    return rows;
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
    const payloadTombstones = Array.isArray(payload.tombstones) ? payload.tombstones : [];

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

    payloadTasks.forEach((row) => {
      if (!row || typeof row.project_id !== "string" || typeof row.id !== "string") return;
      const key = row.project_id + "::" + row.id;
      descriptionsByTaskKey[key] = typeof row.body === "string" ? row.body : "";
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
        description: descriptionsByTaskKey[projectId + "::" + row.id] || "",
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

    payloadTombstones.forEach((row) => {
      if (!row || typeof row.project_id !== "string" || typeof row.task_id !== "string") return;
      const projectId = row.project_id;
      if (!projectsById[projectId]) {
        projectsById[projectId] = createEmptyProjectState(projectId, "");
      }
      const deletedAt = typeof row.deleted_at === "string" ? row.deleted_at : nowIso();
      if (row.is_archived) {
        projectsById[projectId].deletedArchivedTasks = projectsById[projectId].deletedArchivedTasks || {};
        projectsById[projectId].deletedArchivedTasks[row.task_id] = deletedAt;
      } else {
        projectsById[projectId].deletedTasks = projectsById[projectId].deletedTasks || {};
        projectsById[projectId].deletedTasks[row.task_id] = deletedAt;
      }
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
      tombstonesRes,
    ] = await Promise.all([
      supabase
        .schema("todo")
        .from(USER_SETTINGS_TABLE)
        .select("default_project_id, default_project_updated_at, updated_at")
        .eq("user_id", userId)
        .maybeSingle(),
      supabase.schema("todo").from(PROJECTS_TABLE).select("id, name, inactive, last_generated_through, updated_at").eq("user_id", userId),
      supabase.schema("todo").from(TASKS_TABLE).select("id, project_id, name, due_date, source, generated_key, pinned, end_of_day, body, created_at, updated_at").eq("user_id", userId),
      supabase.schema("todo").from(ARCHIVED_TASKS_TABLE).select("id, project_id, name, due_date, source, generated_key, pinned, end_of_day, completed_at, created_at, updated_at").eq("user_id", userId),
      supabase.schema("todo").from(GENERATED_OCCURRENCES_TABLE).select("occurrence_key, project_id, task_id, due_date, task_name, created_at").eq("user_id", userId),
      supabase.schema("todo").from(TASK_TOMBSTONES_TABLE).select("project_id, task_id, is_archived, deleted_at").eq("user_id", userId),
    ]);

    const firstError = [
      userSettingsRes.error,
      projectsRes.error,
      tasksRes.error,
      archivedTasksRes.error,
      generatedOccurrencesRes.error,
      tombstonesRes.error,
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
      tombstones: tombstonesRes.data || [],
    });
  }

  async function pushState() {
    if (!supabase || !currentUser || syncInFlight) return false;

    syncInFlight = true;
    try {
      const userId = currentUser.id;
      const rows = buildNormalizedRowsFromState(appState);
      if (!rows.userSettings) return false;

      const [
        remoteProjectsRes,
        remoteTasksRes,
        remoteArchivedTasksRes,
        remoteGeneratedOccurrencesRes,
      ] = await Promise.all([
        supabase.schema("todo").from(PROJECTS_TABLE).select("id").eq("user_id", userId),
        supabase.schema("todo").from(TASKS_TABLE).select("project_id, id").eq("user_id", userId),
        supabase.schema("todo").from(ARCHIVED_TASKS_TABLE).select("project_id, id").eq("user_id", userId),
        supabase.schema("todo").from(GENERATED_OCCURRENCES_TABLE).select("project_id, occurrence_key").eq("user_id", userId),
      ]);

      const remoteFetchError = [
        remoteProjectsRes.error,
        remoteTasksRes.error,
        remoteArchivedTasksRes.error,
        remoteGeneratedOccurrencesRes.error,
      ].find(Boolean);
      if (remoteFetchError) {
        console.error("Sync push error:", remoteFetchError.message);
        showServerConnectionIssue(remoteFetchError, "sync-push-fetch");
        return false;
      }

      const localProjectIds = new Set(rows.projects.map((row) => row.id));
      const localTaskKeys = new Set(rows.tasks.map((row) => row.project_id + "::" + row.id));
      const localArchivedTaskKeys = new Set(rows.archivedTasks.map((row) => row.project_id + "::" + row.id));
      const localOccurrenceKeys = new Set(rows.generatedOccurrences.map((row) => row.project_id + "::" + row.occurrence_key));

      const deleteOperations = [];
      (remoteProjectsRes.data || []).forEach((row) => {
        if (!localProjectIds.has(row.id)) {
          deleteOperations.push(
            supabase.schema("todo").from(PROJECTS_TABLE).delete().eq("user_id", userId).eq("id", row.id)
          );
        }
      });
      (remoteTasksRes.data || []).forEach((row) => {
        if (!localTaskKeys.has(row.project_id + "::" + row.id)) {
          deleteOperations.push(
            supabase.schema("todo").from(TASKS_TABLE).delete().eq("user_id", userId).eq("project_id", row.project_id).eq("id", row.id)
          );
        }
      });
      (remoteArchivedTasksRes.data || []).forEach((row) => {
        if (!localArchivedTaskKeys.has(row.project_id + "::" + row.id)) {
          deleteOperations.push(
            supabase.schema("todo").from(ARCHIVED_TASKS_TABLE).delete().eq("user_id", userId).eq("project_id", row.project_id).eq("id", row.id)
          );
        }
      });
      (remoteGeneratedOccurrencesRes.data || []).forEach((row) => {
        if (!localOccurrenceKeys.has(row.project_id + "::" + row.occurrence_key)) {
          deleteOperations.push(
            supabase
              .schema("todo")
              .from(GENERATED_OCCURRENCES_TABLE)
              .delete()
              .eq("user_id", userId)
              .eq("project_id", row.project_id)
              .eq("occurrence_key", row.occurrence_key)
          );
        }
      });

      if (deleteOperations.length) {
        const deleteResults = await Promise.all(deleteOperations);
        const deleteError = deleteResults.map((result) => result.error).find(Boolean);
        if (deleteError) {
          console.error("Sync push error:", deleteError.message);
          showServerConnectionIssue(deleteError, "sync-push-delete");
          return false;
        }
      }

      const upsertOperations = [
        supabase.schema("todo").from(USER_SETTINGS_TABLE).upsert(rows.userSettings, { onConflict: "user_id" }),
      ];
      if (rows.projects.length) {
        upsertOperations.push(supabase.schema("todo").from(PROJECTS_TABLE).upsert(rows.projects, { onConflict: "user_id,id" }));
      }
      if (rows.tasks.length) {
        upsertOperations.push(supabase.schema("todo").from(TASKS_TABLE).upsert(rows.tasks, { onConflict: "user_id,project_id,id" }));
      }
      if (rows.archivedTasks.length) {
        upsertOperations.push(supabase.schema("todo").from(ARCHIVED_TASKS_TABLE).upsert(rows.archivedTasks, { onConflict: "user_id,project_id,id" }));
      }
      if (rows.generatedOccurrences.length) {
        upsertOperations.push(
          supabase.schema("todo").from(GENERATED_OCCURRENCES_TABLE).upsert(rows.generatedOccurrences, { onConflict: "user_id,project_id,occurrence_key" })
        );
      }
      if (rows.tombstones.length) {
        upsertOperations.push(
          supabase.schema("todo").from(TASK_TOMBSTONES_TABLE).upsert(rows.tombstones, { onConflict: "user_id,project_id,task_id,is_archived" })
        );
      }

      const upsertResults = await Promise.all(upsertOperations);
      const upsertError = upsertResults.map((result) => result.error).find(Boolean);
      if (upsertError) {
        console.error("Sync push error:", upsertError.message);
        showServerConnectionIssue(upsertError, "sync-push-upsert");
        return false;
      }

      return true;
    } catch (error) {
      console.error("Sync push exception:", error);
      showServerConnectionIssue(error, "sync-push-exception");
      return false;
    } finally {
      syncInFlight = false;
    }
  }

  async function pullState() {
    if (!supabase || !currentUser) return false;

    try {
      const remoteState = await fetchNormalizedRemoteState();
      if (!remoteState) return false;
      appState = mergeStates(appState, remoteState);
      saveStateLocal();
      return true;
    } catch (error) {
      console.error("Sync pull error:", error.message || error);
      showServerConnectionIssue(error, "sync-pull");
      return false;
    }
  }

  async function syncNow() {
    if (!currentUser) return;
    setSyncStatus("Syncing now...");
    const pulled = await pullState();
    const generation = generateTasksForAllProjects();
    if (generation.changed) {
      saveStateLocal();
    }
    const pushed = await pushState();
    renderCurrentScreen();
    if (pulled && pushed) {
      setSyncStatus("Sync complete.");
    } else if (isOfflineModeExpected()) {
      setSyncStatus("Saved locally. Cloud sync will retry when you are online.");
    } else {
      setSyncStatus("Cloud sync failed. Changes are saved locally and will retry.");
      showToast("Cloud sync failed. Local changes are safe.");
    }
  }

  // --- Force resync: compare local vs remote and confirm before merging ---

  async function fetchRemoteStateRaw() {
    if (!supabase || !currentUser) return null;
    try {
      return await fetchNormalizedRemoteState();
    } catch (error) {
      console.error("Resync fetch exception:", error);
      return null;
    }
  }

  function diffLocalRemote(localState, remoteState) {
    const local = normalizeState(localState);
    const remote = normalizeState(remoteState);

    const remoteNewer = []; // changes local will pull from remote
    const localNewer = [];  // changes remote will receive from local

    const allProjectIds = new Set(
      Object.keys(local.projects).concat(Object.keys(remote.projects))
    );

    allProjectIds.forEach((projectId) => {
      const localProject = local.projects[projectId];
      const remoteProject = remote.projects[projectId];

      if (!localProject) {
        const taskCount = Object.keys(remoteProject.tasks || {}).length;
        remoteNewer.push({
          kind: "project",
          label: remoteProject.name || projectId,
          detail: "Project exists remotely only (" + taskCount + " task" + (taskCount === 1 ? "" : "s") + ")",
        });
        return;
      }

      if (!remoteProject) {
        const taskCount = Object.keys(localProject.tasks || {}).length;
        localNewer.push({
          kind: "project",
          label: localProject.name || projectId,
          detail: "Project exists locally only (" + taskCount + " task" + (taskCount === 1 ? "" : "s") + ")",
          projectId,
          discardLocalOnly: true,
        });
        return;
      }

      const projectName = remoteProject.name || localProject.name || projectId;
      const projectCmp = compareIso(localProject.updatedAt, remoteProject.updatedAt);
      if (projectCmp > 0) {
        localNewer.push({
          kind: "project",
          label: localProject.name || projectId,
          detail: "Project metadata modified",
        });
      } else if (projectCmp < 0) {
        remoteNewer.push({
          kind: "project",
          label: remoteProject.name || projectId,
          detail: "Project metadata modified",
        });
      }

      function collectEntityDifferences(localMap, remoteMap, entityLabel, archived) {
        const allIds = new Set(
          Object.keys(localMap || {}).concat(Object.keys(remoteMap || {}))
        );

        allIds.forEach((id) => {
          const localEntity = (localMap || {})[id];
          const remoteEntity = (remoteMap || {})[id];

          if (!localEntity && remoteEntity) {
            remoteNewer.push({
              kind: "task",
              label: remoteEntity.name || id,
              projectName,
              detail: entityLabel + " exists remotely only",
            });
          } else if (localEntity && !remoteEntity) {
            localNewer.push({
              kind: "task",
              label: localEntity.name || id,
              projectName,
              detail: entityLabel + " exists locally only",
              projectId,
              taskId: id,
              archived: !!archived,
              discardLocalOnly: true,
            });
          } else if (localEntity && remoteEntity) {
            const cmp = compareIso(localEntity.updatedAt, remoteEntity.updatedAt);
            if (cmp > 0) {
              localNewer.push({
                kind: "task",
                label: localEntity.name || id,
                projectName,
                detail: entityLabel + " modified",
              });
            } else if (cmp < 0) {
              remoteNewer.push({
                kind: "task",
                label: remoteEntity.name || id,
                projectName,
                detail: entityLabel + " modified",
              });
            }
          }
        });
      }

      collectEntityDifferences(
        localProject.tasks,
        remoteProject.tasks,
        "task",
        false
      );

      collectEntityDifferences(
        localProject.archived,
        remoteProject.archived,
        "completed task",
        true
      );
    });

    return { remoteNewer, localNewer };
  }

  let pendingResyncRemoteState = null;

  function buildResyncDiffHtml(diff) {
    const { remoteNewer, localNewer } = diff;
    const total = remoteNewer.length + localNewer.length;

    if (total === 0) {
      return '<div class="resync-in-sync">&#10003; Everything is in sync — no differences found.</div>';
    }

    const lines = [];

    function renderSection(items, title, badgeClass) {
      if (!items.length) return;
      lines.push('<div class="resync-section">');
      lines.push(
        '<div class="resync-section-heading">' +
        '<span class="resync-section-badge ' + badgeClass + '">' + items.length + '</span>' +
        escapeHtml(title) +
        "</div>"
      );
      lines.push('<ul class="resync-item-list">');
      items.forEach((item) => {
        lines.push('<li class="resync-item">');
        lines.push('<div class="resync-item-main">');
        lines.push('<span class="resync-item-name">' + escapeHtml(item.label) + "</span>");
        const meta = item.projectName
          ? escapeHtml(item.detail) + " &mdash; " + escapeHtml(item.projectName)
          : escapeHtml(item.detail);
        lines.push('<span class="resync-item-meta">' + meta + "</span>");
        lines.push("</div>");
        if (item.discardLocalOnly && item.projectId) {
          const kind = item.kind === "project" ? "project" : "task";
          lines.push(
            '<button type="button" class="btn-secondary resync-item-action-btn" data-resync-action="discard-local" data-item-kind="' +
              kind +
              '" data-project-id="' +
              escapeHtml(item.projectId) +
              '" data-task-id="' +
              escapeHtml(item.taskId || "") +
              '" data-archived="' +
              (item.archived ? "1" : "0") +
              '">Discard local</button>'
          );
        }
        lines.push("</li>");
      });
      lines.push("</ul>");
      lines.push("</div>");
    }

    renderSection(remoteNewer, "Remote is newer — local will receive these changes", "resync-section-badge-remote");
    renderSection(localNewer, "Local is newer — remote will receive these changes", "resync-section-badge-local");

    return lines.join("\n");
  }

  function refreshResyncModalDiff(remoteState) {
    const statusEl = $("#resync-status-text");
    const diffEl = $("#resync-diff");
    const confirmBtn = $("#confirm-resync-btn");
    const pullRemoteBtn = $("#pull-remote-resync-btn");

    const diff = diffLocalRemote(appState, remoteState);
    const total = diff.remoteNewer.length + diff.localNewer.length;

    if (total === 0) {
      statusEl.textContent = "No differences found between local and remote state.";
      confirmBtn.classList.add("hidden");
      pullRemoteBtn.classList.add("hidden");
    } else {
      statusEl.textContent =
        "Found " + total + " difference" + (total === 1 ? "" : "s") + ". " +
        "Use Discard local for locally-only items, Sync both sides to merge changes, or Pull remote only to discard local differences and make local state exactly match remote.";
      confirmBtn.classList.remove("hidden");
      pullRemoteBtn.classList.remove("hidden");
    }

    diffEl.innerHTML = buildResyncDiffHtml(diff);
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function openResyncModal() {
    if (!currentUser || !supabase) return;

    const statusEl = $("#resync-status-text");
    const diffEl = $("#resync-diff");
    const confirmBtn = $("#confirm-resync-btn");
    const pullRemoteBtn = $("#pull-remote-resync-btn");

    statusEl.textContent = "Checking remote state\u2026";
    diffEl.innerHTML = "";
    confirmBtn.classList.add("hidden");
    pullRemoteBtn.classList.add("hidden");
    pendingResyncRemoteState = null;

    $("#resync-modal").classList.remove("hidden");
    $("#resync-modal").setAttribute("aria-hidden", "false");

    if (!navigator.onLine) {
      statusEl.textContent = "You appear to be offline. Please check your connection and try again.";
      return;
    }

    const remoteState = await fetchRemoteStateRaw();

    if (!remoteState) {
      statusEl.textContent = "Could not reach the server. Please check your connection and try again.";
      return;
    }

    pendingResyncRemoteState = remoteState;
    refreshResyncModalDiff(remoteState);
  }

  function closeResyncModal() {
    pendingResyncRemoteState = null;
    $("#resync-modal").classList.add("hidden");
    $("#resync-modal").setAttribute("aria-hidden", "true");
  }

  async function confirmResync() {
    if (!pendingResyncRemoteState) {
      closeResyncModal();
      return;
    }

    const confirmBtn = $("#confirm-resync-btn");
    const cancelBtn = $("#cancel-resync-btn");
    const pullRemoteBtn = $("#pull-remote-resync-btn");
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    pullRemoteBtn.disabled = true;

    setSyncStatus("Resyncing\u2026");
    appState = mergeStates(appState, pendingResyncRemoteState);
    generateTasksForAllProjects();
    saveStateLocal();
    await pushState();
    renderCurrentScreen();
    setSyncStatus("Resync complete.");

    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
    pullRemoteBtn.disabled = false;
    closeResyncModal();
  }

  async function pullRemoteOverrideLocal() {
    if (!pendingResyncRemoteState) {
      closeResyncModal();
      return;
    }

    const confirmBtn = $("#confirm-resync-btn");
    const cancelBtn = $("#cancel-resync-btn");
    const pullRemoteBtn = $("#pull-remote-resync-btn");
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    pullRemoteBtn.disabled = true;

    setSyncStatus("Pulling remote state\u2026");
    appState = normalizeState(pendingResyncRemoteState);
    if (currentProjectId && !appState.projects[currentProjectId]) {
      currentProjectId = null;
    }
    if (appState.defaultProjectId && !appState.projects[appState.defaultProjectId]) {
      appState.defaultProjectId = null;
      appState.defaultProjectUpdatedAt = appState.updatedAt;
    }
    generateTasksForAllProjects();
    saveStateLocal();
    renderCurrentScreen();
    setSyncStatus("Remote pull complete. Local state now exactly matches remote.");

    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
    pullRemoteBtn.disabled = false;
    closeResyncModal();
  }

  function discardLocalOnlyResyncItem(event) {
    const button = event.target.closest(".resync-item-action-btn");
    if (!button || !pendingResyncRemoteState) return;
    if (button.getAttribute("data-resync-action") !== "discard-local") return;

    const itemKind = button.getAttribute("data-item-kind");
    const projectId = button.getAttribute("data-project-id");
    const taskId = button.getAttribute("data-task-id");
    const archived = button.getAttribute("data-archived") === "1";
    const timestamp = nowIso();

    if (!projectId) return;

    if (itemKind === "project") {
      if (!appState.projects[projectId]) return;
      delete appState.projects[projectId];
      delete projectConfigTexts[projectId];
      delete projectConfigs[projectId];
      saveLocalProjectConfigs();
      deleteProjectConfigFromDb(projectId);
      if (currentProjectId === projectId) {
        currentProjectId = null;
      }
      if (appState.defaultProjectId === projectId) {
        appState.defaultProjectId = null;
        appState.defaultProjectUpdatedAt = timestamp;
      }
      appState.updatedAt = timestamp;
    } else if (itemKind === "task" && taskId) {
      const projectState = appState.projects[projectId];
      if (!projectState) return;
      if (archived) {
        if (!projectState.archived[taskId]) return;
        projectState.deletedArchivedTasks = projectState.deletedArchivedTasks || {};
        projectState.deletedArchivedTasks[taskId] = timestamp;
        delete projectState.archived[taskId];
      } else {
        if (!projectState.tasks[taskId]) return;
        projectState.deletedTasks = projectState.deletedTasks || {};
        projectState.deletedTasks[taskId] = timestamp;
        delete projectState.tasks[taskId];
      }
      touchProject(projectState, timestamp);
      deleteTaskDescription(projectId, taskId);
    } else {
      return;
    }

    saveStateLocal();
    renderCurrentScreen();
    refreshResyncModalDiff(pendingResyncRemoteState);
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

  async function upsertTaskDescription(projectId, taskId, body) {
    if (!supabase || !currentUser || !projectId || !taskId) return;
    try {
      const { error } = await supabase
        .schema("todo")
        .from(TASKS_TABLE)
        .update({ body })
        .eq("project_id", projectId)
        .eq("id", taskId)
        .eq("user_id", currentUser.id);
      if (error) {
        console.warn("Failed to save task description:", error.message);
        showServerConnectionIssue(error, "task-description-upsert");
      }
    } catch (error) {
      console.warn("Failed to save task description:", error);
      showServerConnectionIssue(error, "task-description-upsert");
    }
  }

  async function deleteTaskDescription(projectId, taskId) {
    if (!supabase || !currentUser || !projectId || !taskId) return;
    try {
      const { error } = await supabase
        .schema("todo")
        .from(TASKS_TABLE)
        .update({ body: "" })
        .eq("project_id", projectId)
        .eq("id", taskId)
        .eq("user_id", currentUser.id);
      if (error) {
        console.warn("Failed to delete task description:", error.message);
        showServerConnectionIssue(error, "task-description-delete");
      }
    } catch (error) {
      console.warn("Failed to delete task description:", error);
      showServerConnectionIssue(error, "task-description-delete");
    }
  }

  // --------------------------------------------------------

  function createId(prefix) {
    return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  function createStableId(prefix, input) {
    let hash = 2166136261;
    const source = String(input || "");
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return prefix + "_" + (hash >>> 0).toString(36);
  }

  function parseWeeklyQualifier(token) {
    const normalized = String(token || "").trim().toLowerCase();
    return DAY_ALIASES[normalized] || null;
  }

  function parseMonthlyQualifier(token) {
    const value = Number(String(token || "").trim());
    if (!Number.isInteger(value)) return null;
    if (value < 1 || value > 31) return null;
    return value;
  }

  function parseAnnualQualifier(token) {
    const parts = String(token || "").trim().split("-");
    if (parts.length !== 2) return null;
    const month = Number(parts[0]);
    const day = Number(parts[1]);
    if (!Number.isInteger(month) || month < 1 || month > 12) return null;
    if (!Number.isInteger(day) || day < 1 || day > 31) return null;
    return { month, day };
  }

  function parseIntervalQualifier(token) {
    const match = String(token || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    // Reject impossible dates (e.g. February 31st) by round-tripping through Date.
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month || d.getDate() !== day) return null;
    return { year, month, day };
  }

  function parseProjectConfig(text) {
    const rules = [];
    const lines = String(text || "").split(/\r?\n/);

    lines.forEach((rawLine) => {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) return;

      const match = line.match(TASK_LINE);
      if (!match) {
        console.warn("Skipping invalid config line:", rawLine);
        return;
      }

      const name = match[1].trim();
      const frequency = match[2].trim().toLowerCase();
      const qualifierTokens = match[3]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

      const qualifiers = frequency === "weekly"
        ? qualifierTokens.map(parseWeeklyQualifier).filter(Boolean)
        : frequency === "monthly"
        ? qualifierTokens.map(parseMonthlyQualifier).filter((value) => value !== null)
        : /^every\d+weeks$/i.test(frequency) || /^every\d+months$/i.test(frequency)
        ? qualifierTokens.map(parseIntervalQualifier).filter(Boolean)
        : qualifierTokens.map(parseAnnualQualifier).filter(Boolean);

      if (!name || !qualifiers.length) return;

      // Validate that the interval N is at least 1 for every-N-weeks/months rules.
      if (/^every(\d+)(?:weeks|months)$/i.test(frequency)) {
        const intervalMatch = frequency.match(/^every(\d+)/i);
        if (!intervalMatch || parseInt(intervalMatch[1], 10) < 1) return;
      }

      rules.push({
        name,
        frequency,
        qualifiers,
        signature: line.toLowerCase().replace(/\s+/g, ""),
      });
    });

    return rules;
  }

  function getWeekdayToken(dateKey) {
    return WEEKDAY_TOKENS[parseDateKey(dateKey).getDay()];
  }

  function ruleMatchesDate(rule, dateKey) {
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
      const monthDiff = (checkDate.getFullYear() - ref.year) * 12 + (checkDate.getMonth() + 1 - ref.month);
      return monthDiff >= 0 && monthDiff % n === 0;
    }
    // annual
    const date = parseDateKey(dateKey);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return rule.qualifiers.some((q) => q.month === month && q.day === day);
  }

  // --- Project config local cache ---

  function loadLocalProjectConfigs() {
    try {
      const raw = localStorage.getItem(PROJECT_CONFIGS_STORAGE_KEY);
      projectConfigTexts = raw ? JSON.parse(raw) : {};
      if (typeof projectConfigTexts !== "object" || Array.isArray(projectConfigTexts)) {
        projectConfigTexts = {};
      }
    } catch (error) {
      console.warn("Failed to load local project configs:", error);
      projectConfigTexts = {};
    }
  }

  function saveLocalProjectConfigs() {
    try {
      localStorage.setItem(PROJECT_CONFIGS_STORAGE_KEY, JSON.stringify(projectConfigTexts));
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

  function getAllProjects() {
    return Object.keys(appState.projects)
      .map((projectId) => {
        const projectState = appState.projects[projectId];
        return {
          id: projectId,
          name: projectState && projectState.name ? projectState.name : projectId,
          hasConfig: !!(projectConfigs[projectId] && projectConfigs[projectId].length > 0),
          inactive: !!(projectState && projectState.inactive),
          hidden: hiddenProjectIds.has(projectId),
        };
      })
      .filter((project) => project.name && !project.inactive && (!project.hidden || showHiddenProjects))
      .sort((a, b) => a.name.localeCompare(b.name));
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

  function generateTasksForProject(projectId) {
    const rules = projectConfigs[projectId];
    if (!rules || !rules.length) return { created: 0, changed: false };

    const projectState = ensureProjectState(projectId, "");
    const horizonStart = todayKey();
    const horizonEnd = addDays(horizonStart, 6);
    const rangeStart = projectState.lastGeneratedThrough && compareDateKeys(projectState.lastGeneratedThrough, horizonStart) < 0
      ? addDays(projectState.lastGeneratedThrough, 1)
      : horizonStart;

    let created = 0;
    let changed = false;

    enumerateDateKeys(rangeStart, horizonEnd).forEach((dateKey) => {
      rules.forEach((rule) => {
        if (!ruleMatchesDate(rule, dateKey)) return;

        const generatedKey = projectId + "|" + rule.signature + "|" + dateKey;
        if (projectState.generatedOccurrences[generatedKey]) return;

        const timestamp = nowIso();
        const taskId = createStableId("task", generatedKey);
        projectState.tasks[taskId] = {
          id: taskId,
          projectId,
          name: rule.name,
          description: "",
          dueDate: dateKey,
          source: "generated",
          generatedKey,
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: null,
        };
        projectState.generatedOccurrences[generatedKey] = {
          createdAt: timestamp,
          taskId,
          dueDate: dateKey,
          taskName: rule.name,
        };
        touchProject(projectState, timestamp);
        created += 1;
        changed = true;
      });
    });

    if (projectState.lastGeneratedThrough !== horizonEnd) {
      touchProject(projectState);
      projectState.lastGeneratedThrough = horizonEnd;
      changed = true;
    }

    return { created, changed };
  }

  function generateTasksForAllProjects() {
    let created = 0;
    let changed = false;

    Object.keys(projectConfigs).forEach((projectId) => {
      const projectState = appState.projects[projectId];
      if (projectState && projectState.inactive) return;
      const result = generateTasksForProject(projectId);
      created += result.created;
      changed = changed || result.changed;
    });

    return { created, changed };
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
    const dates = enumerateDateKeys(start, addDays(start, 6));
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

  function isOfflineModeExpected() {
    if (!currentUser || !supabase) return true;
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }

  function getErrorMessage(error) {
    if (!error) return "";
    if (typeof error === "string") return error;
    if (typeof error.message === "string") return error.message;
    return String(error);
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
    if (isOfflineModeExpected()) return;
    if (!isServerConnectionError(error)) return;

    setSyncStatus("Could not reach the server. Changes are saved locally and will retry.");

    const now = Date.now();
    if (now - lastServerErrorToastAt >= SERVER_ERROR_TOAST_COOLDOWN_MS) {
      showToast("Could not connect to the server. Working locally for now.");
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
    return {
      required: activeTasks.length + archivedTasks.length,
      complete: archivedTasks.length,
      incomplete: activeTasks.length,
    };
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
      setSyncStatus("Signed in. Changes save after 2 seconds.");
      return;
    }

    $("#user-bar").classList.add("hidden");
    setSyncStatus(supabase ? "Local-only mode. Sign in to sync." : "Local-only mode. Add Supabase keys to enable sync.");
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
    const projects = getAllProjects();
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
    }

    const createProjectBtn = $("#open-create-project-btn");
    if (createProjectBtn) {
      createProjectBtn.classList.toggle("hidden", !showProjectActions);
    }

    const downloadAllArchivesBtn = $("#download-all-archives-btn");
    if (downloadAllArchivesBtn) {
      downloadAllArchivesBtn.classList.toggle("hidden", !showProjectActions);
    }

    const homeAddTaskBtn = $("#open-home-add-task-btn");
    if (homeAddTaskBtn) {
      homeAddTaskBtn.classList.toggle("hidden", !showProjectActions || projects.length === 0);
    }

    const showHiddenBtn = $("#show-hidden-projects-btn");
    if (showHiddenBtn) {
      const hiddenCount = hiddenProjectIds.size === 0 ? 0 : Array.from(hiddenProjectIds).filter((id) => appState.projects[id] && !appState.projects[id].inactive).length;
      showHiddenBtn.classList.toggle("hidden", !showProjectActions || (hiddenCount === 0 && !showHiddenProjects));
      showHiddenBtn.textContent = showHiddenProjects ? "Hide hidden projects" : "Show hidden projects (" + hiddenCount + ")";
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
      const isDefault = appState.defaultProjectId === project.id;
      const isHidden = project.hidden;
      const card = document.createElement("div");
      card.className = "project-card" + (isDefault ? " project-card-default" : "") + (isHidden ? " project-card-hidden" : "");
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
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteProject(project.id);
      });
      topRowActions.appendChild(deleteButton);

      if (isHidden) {
        const unhideButton = document.createElement("button");
        unhideButton.type = "button";
        unhideButton.className = "project-card-unhide";
        unhideButton.textContent = "Unhide";
        unhideButton.title = "Unhide this project on this device.";
        unhideButton.addEventListener("click", (event) => {
          event.stopPropagation();
          unhideProject(project.id);
        });
        topRowActions.appendChild(unhideButton);
      } else {
        const hideButton = document.createElement("button");
        hideButton.type = "button";
        hideButton.className = "project-card-hide";
        hideButton.textContent = "Hide";
        hideButton.title = "Hide this project on this device only. Use 'Show hidden projects' to reveal it again.";
        hideButton.addEventListener("click", (event) => {
          event.stopPropagation();
          hideProject(project.id);
        });
        topRowActions.appendChild(hideButton);

        const inactiveButton = document.createElement("button");
        inactiveButton.type = "button";
        inactiveButton.className = "project-card-inactive";
        inactiveButton.textContent = "Make inactive";
        inactiveButton.title = "Hide this project from the home screen and pause recurring task generation.";
        inactiveButton.addEventListener("click", (event) => {
          event.stopPropagation();
          makeProjectInactive(project.id);
        });
        topRowActions.appendChild(inactiveButton);
      }

      topRow.appendChild(topRowActions);

      const meta = document.createElement("div");
      meta.className = "project-card-meta";
      meta.appendChild(createChip(project.hasConfig ? "recurring" : "manual project"));
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

  function deleteProject(projectId) {
    const project = getProjectMeta(projectId);
    if (!project) return;

    if (!confirm('Delete project "' + project.name + '" and all its tasks?')) return;

    const deletionTime = nowIso();
    delete appState.projects[projectId];
    delete projectConfigTexts[projectId];
    delete projectConfigs[projectId];
    saveLocalProjectConfigs();
    deleteProjectConfigFromDb(projectId);

    if (currentProjectId === projectId) {
      currentProjectId = null;
    }
    if (appState.defaultProjectId === projectId) {
      appState.defaultProjectId = null;
      appState.defaultProjectUpdatedAt = deletionTime;
    }
    if (hiddenProjectIds.has(projectId)) {
      hiddenProjectIds.delete(projectId);
      saveHiddenProjects();
    }
    appState.updatedAt = deletionTime;
    schedulePersist("Saving changes...");
    renderHome();
    showScreen("home");
  }

  function makeProjectInactive(projectId) {
    const project = getProjectMeta(projectId);
    if (!project) return;

    const projectState = ensureProjectState(projectId, "");
    projectState.inactive = true;
    touchProject(projectState);

    if (appState.defaultProjectId === projectId) {
      appState.defaultProjectId = null;
      appState.defaultProjectUpdatedAt = appState.updatedAt;
    }

    schedulePersist("Project set to inactive.");
    renderHome();
  }

  function reactivateProject(projectId) {
    const projectState = ensureProjectState(projectId, "");
    projectState.inactive = false;
    touchProject(projectState);

    const result = generateTasksForProject(projectId);
    if (result.changed) {
      schedulePersist(result.created
        ? "Project reactivated. Generated " + result.created + " new task" + (result.created === 1 ? "" : "s") + "."
        : "Project reactivated.");
    } else {
      schedulePersist("Project reactivated.");
    }

    if (getInactiveProjects().length === 0) {
      renderHome();
      showScreen("home");
    } else {
      renderInactiveProjects();
    }
  }

  function setDefaultProject(projectId) {
    const timestamp = nowIso();
    appState.defaultProjectId = projectId;
    appState.defaultProjectUpdatedAt = timestamp;
    appState.updatedAt = timestamp;
    schedulePersist("Default project saved.");
    renderHome();
  }

  function clearDefaultProject() {
    const timestamp = nowIso();
    appState.defaultProjectId = null;
    appState.defaultProjectUpdatedAt = timestamp;
    appState.updatedAt = timestamp;
    schedulePersist("Default project cleared.");
    renderHome();
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
      title.textContent = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(parseDateKey(dateKey));

      const date = document.createElement("div");
      date.className = "day-date";
      date.textContent = formatDatePill(dateKey);

      const metrics = document.createElement("div");
      metrics.className = "day-metrics";

      if (!stats.required) {
        const emptyCard = document.createElement("div");
        emptyCard.className = "day-card today empty-day-card";
        metrics.appendChild(document.createTextNode("No tasks due today"));
        emptyCard.appendChild(title);
        emptyCard.appendChild(date);
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

      metrics.appendChild(document.createTextNode("Required: " + stats.required));
      metrics.appendChild(document.createElement("br"));
      metrics.appendChild(document.createTextNode("Complete: " + stats.complete));
      metrics.appendChild(document.createElement("br"));
      metrics.appendChild(document.createTextNode("Incomplete: " + stats.incomplete));

      card.appendChild(title);
      card.appendChild(date);
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

    if (selectedTaskView === "overdue" && currentProjectId) {
      const overdueCount = getTaskBuckets(currentProjectId, selectedDate).overdue
        .filter((task) => !getPendingTaskCompletion(currentProjectId, task.id))
        .length;
      if (overdueCount > 0) {
        const completeAllButton = document.createElement("button");
        completeAllButton.type = "button";
        completeAllButton.className = "btn-danger";
        completeAllButton.textContent = "Complete all overdue";
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
    card.className = "task-card";
    if (options.overdue) card.classList.add("overdue");
    if (!task.dueDate) card.classList.add("nodate");
    if (!options.archived && task.pinned) card.classList.add("pinned");
    if (!options.archived && task.endOfDay) card.classList.add("end-of-day");
    const pendingCompletion = !options.archived && getPendingTaskCompletion(task.projectId, task.id);
    if (pendingCompletion) card.classList.add("pending-completion");
    const condensedCard = condensedMode && !options.archived && !pendingCompletion;
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
      const completeButton = document.createElement("button");
      completeButton.type = "button";
      completeButton.className = "task-btn complete";
      completeButton.textContent = "Complete";
      completeButton.addEventListener("click", () => {
        completeTask(task.id);
      });

      const pinButton = document.createElement("button");
      pinButton.type = "button";
      pinButton.className = "task-btn pin";
      pinButton.textContent = task.pinned ? "Unpin" : "Pin";
      pinButton.addEventListener("click", () => {
        togglePinTask(task.id);
      });

      const endOfDayButton = document.createElement("button");
      endOfDayButton.type = "button";
      endOfDayButton.className = "task-btn end-of-day";
      endOfDayButton.textContent = task.endOfDay ? "Remove End of Day" : "End of Day";
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
      deleteButton.addEventListener("click", () => {
        deleteArchivedTask(task.id);
      });
      actions.appendChild(deleteButton);
    } else if (pendingCompletion) {
      actions.classList.add("pending-completion-actions");

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "task-btn cancel-completion";
      cancelButton.textContent = "Cancel Completion...";
      cancelButton.addEventListener("click", () => {
        cancelTaskCompletion(task.id, task.projectId);
      });

      actions.appendChild(cancelButton);
    } else {
      const completeButton = document.createElement("button");
      completeButton.type = "button";
      completeButton.className = "task-btn complete";
      completeButton.textContent = "Complete";
      completeButton.addEventListener("click", () => {
        completeTask(task.id);
      });

      const deferButton = document.createElement("button");
      deferButton.type = "button";
      deferButton.className = "task-btn defer";
      deferButton.textContent = task.dueDate ? "Defer" : "Schedule";
      deferButton.addEventListener("click", () => {
        openDeferModal(task.id);
      });

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "task-btn edit";
      editButton.textContent = "Edit";
      editButton.addEventListener("click", () => {
        openEditModal(task.id);
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "task-btn delete";
      deleteButton.textContent = "Delete";
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
      pinButton.addEventListener("click", () => {
        togglePinTask(task.id);
      });
      actions.appendChild(pinButton);

      const endOfDayButton = document.createElement("button");
      endOfDayButton.type = "button";
      endOfDayButton.className = "task-btn end-of-day";
      endOfDayButton.textContent = task.endOfDay ? "Remove End of Day" : "End of Day";
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
    count.textContent = tasks.length + " task" + (tasks.length === 1 ? "" : "s");

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
      const restAll = [];
      allTasks.forEach((task) => {
        if (task.dueDate && compareDateKeys(task.dueDate, today) < 0) {
          overdueAll.push(task);
        } else if (task.dueDate === today) {
          todayAll.push(task);
        } else {
          restAll.push(task);
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
      taskSections.appendChild(buildTaskSection("Upcoming & Undated", restAll, {
        overdue: false,
        archived: false,
        emptyMessage: "No upcoming tasks.",
      }));
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

  function addManualTaskFromForm(nameInputId, descriptionInputId, dateInputId) {
    const select = $("#add-task-project-select");
    const targetProjectId = (select && select.value) ? select.value : currentProjectId;
    if (!targetProjectId) return false;

    const projectState = ensureProjectState(targetProjectId, "");
    const nameInput = $("#" + nameInputId);
    const descriptionInput = $("#" + descriptionInputId);
    const dateInput = $("#" + dateInputId);
    const name = nameInput.value.trim();
    const description = descriptionInput.value.trim();

    if (!name) return false;

    const timestamp = nowIso();
    const taskId = createId("task");
    const dueDate = isDateKey(dateInput.value) ? dateInput.value : null;

    projectState.tasks[taskId] = {
      id: taskId,
      projectId: targetProjectId,
      name,
      description,
      dueDate,
      source: "manual",
      generatedKey: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };

    touchProject(projectState, timestamp);
    schedulePersist("Saving changes...");

    nameInput.value = "";
    descriptionInput.value = "";
    dateInput.value = "";

    renderCurrentScreen();

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

    // Persist the long description to the dedicated cloud table (fire-and-forget).
    // Always upsert so that a subsequent edit that clears the description is
    // guaranteed to have a row to update rather than leaving stale data.
    upsertTaskDescription(targetProjectId, taskId, description);

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
  }

  function createManualProject(event) {
    event.preventDefault();

    const nameInput = $("#create-project-name-input");
    const name = nameInput.value.trim();
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
    const projectState = ensureProjectState(projectId, name);
    touchProject(projectState);
    schedulePersist("Saving changes...");
    nameInput.value = "";
    closeCreateProjectPanel();
    openProject(projectId);
  }



  // --- Project configuration modal ---

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
    $("#config-modal").classList.remove("hidden");
    $("#config-modal").setAttribute("aria-hidden", "false");
    const builderName = $("#builder-task-name");
    if (builderName) builderName.focus();
  }

  function closeConfigModal() {
    configModalProjectId = null;
    $("#config-modal").classList.add("hidden");
    $("#config-modal").setAttribute("aria-hidden", "true");
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
    if (!weekly || !monthly || !annual || !everyWeeks || !everyMonths) return;
    const val = cadence ? cadence.value : "weekly";
    weekly.classList.toggle("hidden", val !== "weekly");
    monthly.classList.toggle("hidden", val !== "monthly");
    annual.classList.toggle("hidden", val !== "annual");
    everyWeeks.classList.toggle("hidden", val !== "everyweeks");
    everyMonths.classList.toggle("hidden", val !== "everymonths");
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
      if (textarea) textarea.value = text;
    };
    reader.readAsText(file);
    // Reset file input so the same file can be re-uploaded if needed.
    event.target.value = "";
  }

  async function saveProjectConfig(event) {
    event.preventDefault();
    if (!configModalProjectId) return;

    const textarea = $("#config-modal-textarea");
    const errorEl = $("#config-modal-error");
    const configText = textarea ? textarea.value : "";
    const rules = parseProjectConfig(configText);

    if (configText.trim() && !rules.length) {
      if (errorEl) {
        errorEl.textContent = "No valid task rules found. Each rule must be in the format: task name-weekly-day, task name-monthly-dayOfMonth, task name-annual-MM-DD, task name-everyNweeks-YYYY-MM-DD, or task name-everyNmonths-YYYY-MM-DD.";
        errorEl.classList.remove("hidden");
      }
      return;
    }

    if (errorEl) {
      errorEl.textContent = "";
      errorEl.classList.add("hidden");
    }

    const projectId = configModalProjectId;
    projectConfigTexts[projectId] = configText;
    projectConfigs[projectId] = rules;
    saveLocalProjectConfigs();
    upsertProjectConfigToDb(projectId, configText);

    closeConfigModal();

    const result = generateTasksForProject(projectId);
    if (result.changed) {
      schedulePersist(result.created ? "Config saved. Generated " + result.created + " new task" + (result.created === 1 ? "" : "s") + "." : "Config saved.");
    } else {
      setSyncStatus("Config saved.");
      schedulePersist("Saving changes...");
    }

    renderCurrentScreen();
  }

  async function clearProjectConfig() {
    if (!configModalProjectId) return;
    if (!confirm("Clear the recurring configuration for this project? Existing generated tasks will remain but no new ones will be created.")) return;

    const projectId = configModalProjectId;
    delete projectConfigTexts[projectId];
    delete projectConfigs[projectId];
    saveLocalProjectConfigs();
    deleteProjectConfigFromDb(projectId);

    closeConfigModal();
    setSyncStatus("Configuration cleared.");
    schedulePersist("Saving changes...");
    renderCurrentScreen();
  }

  function completeTask(taskId) {
    if (!currentProjectId) return;
    const projectState = ensureProjectState(currentProjectId, "");
    const task = projectState.tasks[taskId];
    if (!task) return;
    if (getPendingTaskCompletion(currentProjectId, taskId)) return;

    const projectId = currentProjectId;
    const pendingKey = buildPendingTaskCompletionKey(projectId, taskId);
    pendingTaskCompletions[pendingKey] = {
      projectId,
      taskId,
      timeoutId: setTimeout(() => {
        finalizeTaskCompletion(projectId, taskId);
      }, COMPLETE_DELAY_MS),
    };

    renderCurrentScreen();
  }

  function archiveTask(projectState, taskId, timestamp) {
    const task = projectState.tasks[taskId];
    if (!task) return false;
    delete projectState.tasks[taskId];
    projectState.archived[taskId] = {
      ...task,
      completedAt: timestamp,
      updatedAt: timestamp,
    };
    return true;
  }

  function completeAllOverdueTasks() {
    if (!currentProjectId) return;
    const projectId = currentProjectId;
    const overdueTaskIds = getTaskBuckets(projectId, selectedDate).overdue
      .map((task) => task.id)
      .filter((taskId) => !getPendingTaskCompletion(projectId, taskId));
    const totalOverdue = overdueTaskIds.length;
    if (!totalOverdue) return;

    if (!confirm(`Are you sure you definitely want to complete all ${totalOverdue} overdue task${totalOverdue === 1 ? "" : "s"} for this project?`)) return;

    const projectState = ensureProjectState(projectId, "");
    const timestamp = nowIso();
    let completedCount = 0;
    overdueTaskIds.forEach((taskId) => {
      clearPendingTaskCompletion(projectId, taskId);
      if (archiveTask(projectState, taskId, timestamp)) {
        completedCount++;
      }
    });

    if (!completedCount) return;
    touchProject(projectState, timestamp);
    schedulePersist("Saving changes...");
    renderCurrentScreen();
  }

  function cancelTaskCompletion(taskId, projectId) {
    const resolvedProjectId = projectId || currentProjectId;
    if (!resolvedProjectId) return;
    if (!clearPendingTaskCompletion(resolvedProjectId, taskId)) return;
    renderCurrentScreen();
  }

  function finalizeTaskCompletion(projectId, taskId) {
    if (!clearPendingTaskCompletion(projectId, taskId)) return;

    const projectState = appState.projects[projectId];
    if (!projectState) {
      renderCurrentScreen();
      return;
    }
    const timestamp = nowIso();
    if (!archiveTask(projectState, taskId, timestamp)) {
      renderCurrentScreen();
      return;
    }
    touchProject(projectState, timestamp);
    schedulePersist("Saving changes...");
    renderCurrentScreen();
  }

  async function openEditModal(taskId) {
    const task = getActiveTask(taskId);
    if (!task) return;

    editTaskId = taskId;
    configureTaskDateInput("edit-task-date-input");
    $("#edit-task-name-input").value = task.name || "";
    $("#edit-task-description-input").value = task.description || "";
    $("#edit-task-date-input").value = task.dueDate || "";
    $("#edit-modal").classList.remove("hidden");
    $("#edit-modal").setAttribute("aria-hidden", "false");

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
    $("#edit-modal").classList.add("hidden");
    $("#edit-modal").setAttribute("aria-hidden", "true");
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
    $("#add-task-modal").classList.remove("hidden");
    $("#add-task-modal").setAttribute("aria-hidden", "false");
    $("#add-task-name-input").focus();
  }

  function closeAddTaskModal() {
    $("#add-task-modal").classList.add("hidden");
    $("#add-task-modal").setAttribute("aria-hidden", "true");
  }

  function submitAddTask(event) {
    event.preventDefault();
    const added = addManualTaskFromForm("add-task-name-input", "add-task-description-input", "add-task-date-input");
    if (!added) return;

    closeAddTaskModal();
  }

  function saveEditedTask(event) {
    event.preventDefault();
    if (!currentProjectId || !editTaskId) return;

    const projectState = ensureProjectState(currentProjectId, "");
    const task = projectState.tasks[editTaskId];
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
    const timestamp = nowIso();
    task.name = name;
    task.description = description;
    task.dueDate = dueDate;
    task.updatedAt = timestamp;
    touchProject(projectState, timestamp);
    schedulePersist("Saving changes...");

    closeEditModal();
    renderCurrentScreen();

    // Persist the long description to the dedicated cloud table (fire-and-forget).
    upsertTaskDescription(currentProjectId, savedTaskId, description);
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
    $("#defer-modal").classList.remove("hidden");
    $("#defer-modal").setAttribute("aria-hidden", "false");
  }

  function closeDeferModal() {
    deferTaskId = null;
    $("#defer-modal").classList.add("hidden");
    $("#defer-modal").setAttribute("aria-hidden", "true");
  }

  function deferToDate(dateKey) {
    if (!currentProjectId || !deferTaskId) return;
    const projectState = ensureProjectState(currentProjectId, "");
    const task = projectState.tasks[deferTaskId];
    if (!task) {
      closeDeferModal();
      return;
    }

    const timestamp = nowIso();
    task.dueDate = dateKey;
    task.updatedAt = timestamp;
    touchProject(projectState, timestamp);
    schedulePersist("Saving changes...");
    closeDeferModal();
    renderDayView();
  }

  function clearDeferDate() {
    if (!currentProjectId || !deferTaskId) return;
    const projectState = ensureProjectState(currentProjectId, "");
    const task = projectState.tasks[deferTaskId];
    if (!task) {
      closeDeferModal();
      return;
    }

    const timestamp = nowIso();
    task.dueDate = null;
    task.updatedAt = timestamp;
    touchProject(projectState, timestamp);
    schedulePersist("Saving changes...");
    closeDeferModal();
    renderDayView();
  }

  function togglePinTask(taskId) {
    if (!currentProjectId) return;
    const projectState = ensureProjectState(currentProjectId, "");
    const task = projectState.tasks[taskId];
    if (!task) return;

    const timestamp = nowIso();
    task.pinned = !task.pinned;
    if (task.pinned) task.endOfDay = false;
    task.updatedAt = timestamp;
    touchProject(projectState, timestamp);
    schedulePersist("Saving changes...");
    renderCurrentScreen();
  }

  function toggleEndOfDayTask(taskId) {
    if (!currentProjectId) return;
    const projectState = ensureProjectState(currentProjectId, "");
    const task = projectState.tasks[taskId];
    if (!task) return;

    const timestamp = nowIso();
    task.endOfDay = !task.endOfDay;
    if (task.endOfDay) task.pinned = false;
    task.updatedAt = timestamp;
    touchProject(projectState, timestamp);
    schedulePersist("Saving changes...");
    renderCurrentScreen();
  }

  function hardDeleteTask(taskId) {
    if (!currentProjectId) return;
    const projectState = ensureProjectState(currentProjectId, "");
    const task = projectState.tasks[taskId];
    if (!task) return;

    if (!confirm('Delete "' + task.name + '" permanently? This will not move it to the archive.')) return;

    const timestamp = nowIso();
    projectState.deletedTasks = projectState.deletedTasks || {};
    projectState.deletedTasks[taskId] = timestamp;
    delete projectState.tasks[taskId];
    touchProject(projectState, timestamp);
    schedulePersist("Saving changes...");
    renderCurrentScreen();

    // Remove the cloud description for this task (fire-and-forget).
    deleteTaskDescription(currentProjectId, taskId);
  }

  function deleteArchivedTask(taskId) {
    if (!currentProjectId) return;
    const projectState = ensureProjectState(currentProjectId, "");
    const task = projectState.archived[taskId];
    if (!task) return;

    if (!confirm('Delete archived task "' + task.name + '"?')) return;

    const timestamp = nowIso();
    projectState.deletedArchivedTasks = projectState.deletedArchivedTasks || {};
    projectState.deletedArchivedTasks[taskId] = timestamp;
    delete projectState.archived[taskId];
    touchProject(projectState, timestamp);
    schedulePersist("Saving changes...");
    renderArchiveScreen();

    // Remove the cloud description for this task (fire-and-forget).
    deleteTaskDescription(currentProjectId, taskId);
  }

  function clearArchive() {
    if (!currentProjectId) return;
    const projectState = ensureProjectState(currentProjectId, "");
    const archiveIds = Object.keys(projectState.archived);
    if (!archiveIds.length) return;

    if (!confirm("Delete the entire archive for this project?")) return;

    const timestamp = nowIso();
    projectState.deletedArchivedTasks = projectState.deletedArchivedTasks || {};
    archiveIds.forEach((taskId) => {
      projectState.deletedArchivedTasks[taskId] = timestamp;
      delete projectState.archived[taskId];
      // Remove the cloud description for each deleted task (fire-and-forget).
      deleteTaskDescription(currentProjectId, taskId);
    });
    touchProject(projectState, timestamp);
    schedulePersist("Saving changes...");
    renderArchiveScreen();
  }

  function downloadTextFile(filename, contents) {
    const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
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

  function deleteAllArchivedTasks() {
    const allProjects = [...getAllProjects(), ...getInactiveProjects()];
    const projectArchives = allProjects.map((project) => ({
      project,
      archiveIds: Object.keys(getProjectState(project.id).archived || {}),
    }));
    const totalArchived = projectArchives.reduce((sum, entry) => sum + entry.archiveIds.length, 0);
    if (!totalArchived) return;

    if (!confirm("Delete " + totalArchived + " archived task" + (totalArchived === 1 ? "" : "s") + " across all projects?")) return;

    const timestamp = nowIso();
    projectArchives.forEach(({ project, archiveIds }) => {
      if (!archiveIds.length) return;
      const projectState = ensureProjectState(project.id, "");
      projectState.deletedArchivedTasks = projectState.deletedArchivedTasks || {};
      archiveIds.forEach((taskId) => {
        projectState.deletedArchivedTasks[taskId] = timestamp;
        delete projectState.archived[taskId];
        deleteTaskDescription(project.id, taskId);
      });
      touchProject(projectState, timestamp);
    });

    schedulePersist("Saving changes...");

    const deleteBtn = $("#delete-all-archives-btn");
    if (deleteBtn) deleteBtn.disabled = true;
  }

  function refreshCurrentProject() {
    if (!currentProjectId) return;
    const project = getProjectMeta(currentProjectId);
    if (!project || !project.hasConfig) {
      setSyncStatus("This project has no recurring config file to refresh.");
      return;
    }
    const result = generateTasksForProject(currentProjectId);
    if (result.changed) {
      schedulePersist(result.created ? "Generated " + result.created + " new task" + (result.created === 1 ? "" : "s") + "." : "Generation window refreshed.");
    } else {
      setSyncStatus("No new tasks were needed.");
    }
    renderCurrentScreen();
  }

  function refreshAllProjects() {
    const result = generateTasksForAllProjects();
    if (result.changed) {
      schedulePersist(result.created ? "Generated " + result.created + " new task" + (result.created === 1 ? "" : "s") + "." : "Generation window refreshed.");
    } else {
      setSyncStatus("No new tasks were needed.");
    }
    renderCurrentScreen();
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

    $("#skip-auth-btn").addEventListener("click", () => {
      enterApp();
    });
  }

  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;

    $("#generate-all-btn").addEventListener("click", refreshAllProjects);
    $("#toggle-project-actions-btn").addEventListener("click", () => {
      showProjectActions = !showProjectActions;
      renderHome();
    });
    $("#open-create-project-btn").addEventListener("click", openCreateProjectPanel);
    $("#cancel-create-project-btn").addEventListener("click", closeCreateProjectPanel);
    $("#view-inactive-btn").addEventListener("click", openInactiveProjects);
    $("#show-hidden-projects-btn").addEventListener("click", () => {
      showHiddenProjects = !showHiddenProjects;
      renderHome();
    });
    $("#open-home-add-task-btn").addEventListener("click", () => {
      openAddTaskModal(null);
    });
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
    document.querySelectorAll('input[name="builder-cadence"]').forEach((radio) => {
      radio.addEventListener("change", updateBuilderScheduleVisibility);
    });
    $("#builder-add-btn").addEventListener("click", handleBuilderAddTask);
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

    $("#force-resync-btn").addEventListener("click", async () => {
      $("#force-resync-btn").disabled = true;
      await openResyncModal();
      $("#force-resync-btn").disabled = false;
    });

    $("#cancel-resync-btn").addEventListener("click", closeResyncModal);
    $("#confirm-resync-btn").addEventListener("click", confirmResync);
    $("#pull-remote-resync-btn").addEventListener("click", pullRemoteOverrideLocal);
    $("#resync-diff").addEventListener("click", discardLocalOnlyResyncItem);
    $("#resync-modal").addEventListener("click", (event) => {
      if (event.target === $("#resync-modal")) {
        closeResyncModal();
      }
    });

    $("#logout-btn").addEventListener("click", async () => {
      if (supabase) {
        await supabase.auth.signOut();
      }
      clearAllPendingTaskCompletions();
      currentUser = null;
      appEntered = false;
      currentProjectId = null;
      showScreen("auth");
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        flushLocalState();
      }
    });

    window.addEventListener("beforeunload", flushLocalState);
  }

  async function enterApp() {
    if (appEntered) {
      return;
    }

    appEntered = true;
    loadLocalState();
    loadLocalProjectConfigs();
    loadHiddenProjects();
    rebuildProjectConfigs();

    if (currentUser) {
      await pullState();
      await fetchAllProjectConfigsFromDb();
    }

    const generation = generateTasksForAllProjects();

    showUserBar();

    const defaultId = appState.defaultProjectId;
    if (defaultId && getProjectMeta(defaultId) && !hiddenProjectIds.has(defaultId)) {
      currentProjectId = defaultId;
      renderHome();
      openDay(todayKey());
    } else {
      renderHome();
      showScreen("home");
    }

    if (generation.changed) {
      schedulePersist(generation.created ? "Generated " + generation.created + " new task" + (generation.created === 1 ? "" : "s") + "." : "Saving changes...");
    }
  }

  async function init() {
    bindEvents();

    if (supabase) {
      bindAuthEvents();

      const sessionResponse = await supabase.auth.getSession();
      if (sessionResponse.data && sessionResponse.data.session && sessionResponse.data.session.user) {
        currentUser = sessionResponse.data.session.user;
        await enterApp();
      } else {
        showScreen("auth");
      }

      supabase.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_IN" && session && session.user) {
          currentUser = session.user;
          enterApp();
        } else if (event === "SIGNED_OUT") {
          clearAllPendingTaskCompletions();
          currentUser = null;
          appEntered = false;
          currentProjectId = null;
          showScreen("auth");
        }
      });
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
