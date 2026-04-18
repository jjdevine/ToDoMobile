(function () {
  "use strict";

  const STORAGE_KEY = "task_planner_state_v1";
  const TABLE_NAME = "todo_state";
  const SAVE_DELAY_MS = 2000;
  const COMPLETE_DELAY_MS = 2000;
  const SUPABASE_PLACEHOLDER = "https://YOUR_PROJECT_REF.supabase.co";
  const TASK_LINE = /^\s*(.+?)\s*-\s*(weekly|monthly)\s*-\s*(.+?)\s*$/i;
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

  const supabaseConfigured =
    typeof window.supabase !== "undefined" &&
    typeof SUPABASE_URL !== "undefined" &&
    typeof SUPABASE_ANON_KEY !== "undefined" &&
    SUPABASE_URL &&
    SUPABASE_URL !== SUPABASE_PLACEHOLDER &&
    !/YOUR_PROJECT_REF/i.test(SUPABASE_URL) &&
    SUPABASE_ANON_KEY &&
    !/YOUR_SUPABASE_ANON_KEY/i.test(SUPABASE_ANON_KEY);

  const supabase = supabaseConfigured
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
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

  let manifest = { buildTime: Date.now(), projects: [] };
  let projectConfigs = {};
  let appState = createEmptyState();

  function nowIso() {
    return new Date().toISOString();
  }

  function createEmptyState() {
    return {
      version: 1,
      updatedAt: nowIso(),
      projects: {},
      defaultProjectId: null,
    };
  }

  function createEmptyProjectState(projectId, name) {
    return {
      projectId,
      name: name || "",
      tasks: {},
      archived: {},
      generatedOccurrences: {},
      deletedTaskIds: {},
      deletedArchiveIds: {},
      lastGeneratedThrough: null,
      updatedAt: nowIso(),
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
      tasks: normalizeTaskMap(rawProject.tasks, projectId, false),
      archived: normalizeTaskMap(rawProject.archived, projectId, true),
      generatedOccurrences: normalizeGeneratedOccurrences(rawProject.generatedOccurrences),
      deletedTaskIds: normalizeTimestampMap(rawProject.deletedTaskIds),
      deletedArchiveIds: normalizeTimestampMap(rawProject.deletedArchiveIds),
      lastGeneratedThrough: isDateKey(rawProject.lastGeneratedThrough) ? rawProject.lastGeneratedThrough : null,
      updatedAt: typeof rawProject.updatedAt === "string" ? rawProject.updatedAt : nowIso(),
    };
  }

  function normalizeState(rawState) {
    const normalized = createEmptyState();
    if (!isPlainObject(rawState)) return normalized;

    normalized.version = Number(rawState.version) || 1;
    normalized.updatedAt = typeof rawState.updatedAt === "string" ? rawState.updatedAt : nowIso();
    normalized.projects = {};
    normalized.defaultProjectId = typeof rawState.defaultProjectId === "string" ? rawState.defaultProjectId : null;

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

  function mergeProjectStates(projectId, localProject, remoteProject) {
    if (!localProject) return normalizeProjectState(projectId, remoteProject);
    if (!remoteProject) return normalizeProjectState(projectId, localProject);

    const normalizedLocal = normalizeProjectState(projectId, localProject);
    const normalizedRemote = normalizeProjectState(projectId, remoteProject);

    const deletedTaskIds = mergeTimestampMaps(normalizedLocal.deletedTaskIds, normalizedRemote.deletedTaskIds);
    const deletedArchiveIds = mergeTimestampMaps(normalizedLocal.deletedArchiveIds, normalizedRemote.deletedArchiveIds);

    return {
      projectId,
      name: normalizedRemote.name || normalizedLocal.name || "",
      tasks: mergeEntityMaps(normalizedLocal.tasks, normalizedRemote.tasks, deletedTaskIds),
      archived: mergeEntityMaps(normalizedLocal.archived, normalizedRemote.archived, deletedArchiveIds),
      generatedOccurrences: mergeGeneratedOccurrences(normalizedLocal.generatedOccurrences, normalizedRemote.generatedOccurrences),
      deletedTaskIds,
      deletedArchiveIds,
      lastGeneratedThrough: maxDateKey(normalizedLocal.lastGeneratedThrough, normalizedRemote.lastGeneratedThrough),
      updatedAt: laterIso(normalizedLocal.updatedAt, normalizedRemote.updatedAt),
    };
  }

  function mergeStates(localState, remoteState) {
    const local = normalizeState(localState);
    const remote = normalizeState(remoteState);
    const merged = createEmptyState();
    const projectIds = new Set(Object.keys(local.projects).concat(Object.keys(remote.projects)));

    projectIds.forEach((projectId) => {
      merged.projects[projectId] = mergeProjectStates(projectId, local.projects[projectId], remote.projects[projectId]);
    });

    merged.updatedAt = laterIso(local.updatedAt, remote.updatedAt);
    merged.defaultProjectId = compareIso(local.updatedAt, remote.updatedAt) >= 0 ? local.defaultProjectId : remote.defaultProjectId;
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

  async function pushState() {
    if (!supabase || !currentUser || syncInFlight) return false;

    syncInFlight = true;
    try {
      const { error } = await supabase.from(TABLE_NAME).upsert({
        user_id: currentUser.id,
        state_data: appState,
        updated_at: appState.updatedAt,
      });

      if (error) {
        console.error("Sync push error:", error.message);
        return false;
      }

      return true;
    } catch (error) {
      console.error("Sync push exception:", error);
      return false;
    } finally {
      syncInFlight = false;
    }
  }

  async function pullState() {
    if (!supabase || !currentUser) return;

    try {
      const { data, error } = await supabase
        .from(TABLE_NAME)
        .select("*")
        .eq("user_id", currentUser.id)
        .maybeSingle();

      if (error) {
        console.error("Sync pull error:", error.message);
        return;
      }

      if (!data || !data.state_data) return;
      const remoteState = normalizeState(data.state_data);
      if (!remoteState.updatedAt && data.updated_at) {
        remoteState.updatedAt = data.updated_at;
      }
      appState = mergeStates(appState, remoteState);
      saveStateLocal();
    } catch (error) {
      console.error("Sync pull exception:", error);
    }
  }

  async function syncNow() {
    if (!currentUser) return;
    setSyncStatus("Syncing now...");
    await pullState();
    const generation = generateTasksForAllProjects();
    if (generation.changed) {
      saveStateLocal();
    }
    await pushState();
    renderCurrentScreen();
    setSyncStatus("Sync complete.");
  }

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
        : qualifierTokens.map(parseMonthlyQualifier).filter((value) => value !== null);

      if (!name || !qualifiers.length) return;

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
    return rule.qualifiers.indexOf(parseDateKey(dateKey).getDate()) >= 0;
  }

  async function loadManifest() {
    try {
      const response = await fetch("manifest.json?v=" + Date.now());
      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }
      manifest = await response.json();
      if (!Array.isArray(manifest.projects)) {
        manifest.projects = [];
      }
    } catch (error) {
      console.warn("Manifest could not be loaded:", error);
      manifest = { buildTime: Date.now(), projects: [] };
    }
  }

  async function loadProjectConfigs() {
    projectConfigs = {};
    await Promise.all(
      manifest.projects.map(async (project) => {
        try {
          const response = await fetch(project.file + "?v=" + manifest.buildTime);
          if (!response.ok) {
            throw new Error("HTTP " + response.status);
          }
          const text = await response.text();
          projectConfigs[project.id] = parseProjectConfig(text);
        } catch (error) {
          console.warn("Project config could not be loaded:", project.file, error);
          projectConfigs[project.id] = [];
        }
      })
    );
  }

  function getManifestProject(projectId) {
    return manifest.projects.find((project) => project.id === projectId) || null;
  }

  function getManualProjects() {
    const manifestIds = new Set(manifest.projects.map((project) => project.id));
    return Object.keys(appState.projects)
      .filter((projectId) => !manifestIds.has(projectId))
      .map((projectId) => {
        const projectState = appState.projects[projectId];
        return {
          id: projectId,
          name: projectState && projectState.name ? projectState.name : projectId,
          file: null,
          hasConfig: false,
        };
      })
      .filter((project) => project.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function getAllProjects() {
    return manifest.projects
      .map((project) => ({
        ...project,
        hasConfig: true,
      }))
      .concat(getManualProjects());
  }

  function getProjectMeta(projectId) {
    const manifestProject = getManifestProject(projectId);
    if (manifestProject) {
      return {
        ...manifestProject,
        hasConfig: true,
      };
    }

    const projectState = appState.projects[projectId];
    if (!projectState || !projectState.name) return null;

    return {
      id: projectId,
      name: projectState.name,
      file: null,
      hasConfig: false,
    };
  }

  function buildManualProjectId(name) {
    const slug = String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "project";
    let candidate = "manual-" + slug;
    let suffix = 2;

    while (getProjectMeta(candidate) || appState.projects[candidate]) {
      candidate = "manual-" + slug + "-" + suffix;
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

  function ensureManifestProjectsInState() {
    let changed = false;
    manifest.projects.forEach((project) => {
      if (!appState.projects[project.id]) {
        appState.projects[project.id] = createEmptyProjectState(project.id, project.name);
        changed = true;
        return;
      }

      if (appState.projects[project.id].name !== project.name) {
        appState.projects[project.id].name = project.name;
        appState.projects[project.id].updatedAt = nowIso();
        changed = true;
      }
    });

    if (changed) {
      appState.updatedAt = nowIso();
    }

    return changed;
  }

  function generateTasksForProject(projectId) {
    const projectManifest = getManifestProject(projectId);
    if (!projectManifest) return { created: 0, changed: false };

    const projectState = ensureProjectState(projectId, projectManifest.name);
    const rules = projectConfigs[projectId] || [];
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

    manifest.projects.forEach((project) => {
      const result = generateTasksForProject(project.id);
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
      const pinnedA = a.pinned ? 0 : 1;
      const pinnedB = b.pinned ? 0 : 1;
      if (pinnedA !== pinnedB) return pinnedA - pinnedB;
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

  function getDeferDates() {
    const start = todayKey();
    return enumerateDateKeys(addDays(start, 1), addDays(start, 6));
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
    $("#auth-screen").classList.toggle("active", name === "auth");
    $("#home-screen").classList.toggle("active", name === "home");
    $("#project-screen").classList.toggle("active", name === "project");
    $("#day-screen").classList.toggle("active", name === "day");
    $("#archive-screen").classList.toggle("active", name === "archive");
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

  function renderHome() {
    closeCreateProjectPanel();
    const projectGrid = $("#project-grid");
    const emptyState = $("#home-empty");
    projectGrid.innerHTML = "";
    const projects = getAllProjects();

    if (!projects.length) {
      emptyState.classList.remove("hidden");
      return;
    }

    emptyState.classList.add("hidden");

    projects.forEach((project) => {
      const stats = buildProjectStats(project.id);
      const projectState = ensureProjectState(project.id, project.name);
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
      defaultButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (isDefault) {
          clearDefaultProject();
        } else {
          setDefaultProject(project.id);
        }
      });
      topRowActions.appendChild(defaultButton);

      if (!project.hasConfig) {
        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "project-card-delete";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", (event) => {
          event.stopPropagation();
          deleteManualProject(project.id);
        });
        topRowActions.appendChild(deleteButton);
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
          : "Manual project with your own tasks";

      card.appendChild(topRow);
      card.appendChild(meta);
      card.appendChild(footer);
      projectGrid.appendChild(card);
    });
  }

  function deleteManualProject(projectId) {
    const project = getProjectMeta(projectId);
    if (!project || project.hasConfig) return;

    if (!confirm('Delete manual project "' + project.name + '" and all its tasks?')) return;

    delete appState.projects[projectId];
    if (currentProjectId === projectId) {
      currentProjectId = null;
    }
    if (appState.defaultProjectId === projectId) {
      appState.defaultProjectId = null;
    }
    appState.updatedAt = nowIso();
    schedulePersist("Saving changes...");
    renderHome();
    showScreen("home");
  }

  function setDefaultProject(projectId) {
    appState.defaultProjectId = projectId;
    appState.updatedAt = nowIso();
    schedulePersist("Default project saved.");
    renderHome();
  }

  function clearDefaultProject() {
    appState.defaultProjectId = null;
    appState.updatedAt = nowIso();
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
      button.title = hasConfig ? "Generate any recurring tasks now" : "This project does not have a recurring configuration file.";
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

    container.appendChild(buildProjectTaskViewCard(
      "Overdue",
      overdueTasks.length
        ? overdueTasks.length + " overdue task" + (overdueTasks.length === 1 ? "" : "s")
        : "No overdue tasks",
      oldestDueDate
        ? "Open overdue task list · Oldest due: " + formatDatePill(oldestDueDate)
        : "Open overdue task list",
      () => {
        openOverdue();
      },
      "overdue-entry-card" + (overdueTasks.length ? " has-overdue-tasks" : ""),
      selectedTaskView === "overdue"
    ));

    container.appendChild(buildProjectTaskViewCard(
      "No Due Date",
      noDateTasks.length
        ? noDateTasks.length + " task" + (noDateTasks.length === 1 ? "" : "s") + " with no due date"
        : "No tasks without a due date",
      "Open no due date task list",
      () => {
        openNoDueDate();
      },
      "nodate-entry-card",
      selectedTaskView === "nodate"
    ));
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

  function buildTaskCard(task, options) {
    const card = document.createElement("div");
    card.className = "task-card";
    if (options.overdue) card.classList.add("overdue");
    if (!task.dueDate) card.classList.add("nodate");
    if (!options.archived && task.pinned) card.classList.add("pinned");
    const pendingCompletion = !options.archived && getPendingTaskCompletion(task.projectId, task.id);
    if (pendingCompletion) card.classList.add("pending-completion");
    const condensedCard = condensedMode && !options.archived && !pendingCompletion;
    const expandedInCondensed = condensedCard ? isTaskExpanded(task) : false;
    if (condensedCard && !expandedInCondensed) card.classList.add("condensed");

    const titleRow = document.createElement("div");
    titleRow.className = "task-card-title-row";

    const title = document.createElement("h4");
    title.textContent = task.name;
    titleRow.appendChild(title);

    if (!options.archived && task.pinned) {
      const pinBadge = document.createElement("span");
      pinBadge.className = "pin-badge";
      pinBadge.textContent = "📌 Pinned";
      titleRow.appendChild(pinBadge);
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
      actions.appendChild(expandButton);
      card.appendChild(actions);
      return card;
    }

    if (task.description) {
      const description = document.createElement("p");
      description.className = "task-description";
      description.textContent = task.description;
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
    list.className = "task-list";
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

    taskSections.appendChild(buildTaskSection(formatDateLong(selectedDate), taskBuckets.selected, {
      overdue: false,
      archived: false,
      emptyMessage: "No tasks are due on this day.",
    }));

    if (taskBuckets.future.length) {
      taskSections.appendChild(buildTaskSection("Other Future Tasks", taskBuckets.future, {
        overdue: false,
        archived: false,
      }));
    }
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
      : "Manual project. Add your own tasks and use the date list to focus each day.";

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

  function openFutureTasks() {
    selectedTaskView = "future";
    renderDayView();
  }

  function openArchive() {
    renderArchiveScreen();
    showScreen("archive");
  }

  function getActiveTask(taskId) {
    if (!currentProjectId) return null;
    return getProjectState(currentProjectId).tasks[taskId] || null;
  }

  function addManualTaskFromForm(nameInputId, descriptionInputId, dateInputId) {
    if (!currentProjectId) return false;

    const projectState = ensureProjectState(currentProjectId, "");
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
      projectId: currentProjectId,
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
    if (dueDate && compareDateKeys(dueDate, todayKey()) >= 0 && compareDateKeys(dueDate, addDays(todayKey(), 6)) <= 0) {
      selectedDate = dueDate;
    }

    renderCurrentScreen();
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

    const existingProject = getAllProjects().find((project) => project.name.toLowerCase() === name.toLowerCase());
    if (existingProject) {
      setSyncStatus('A project named "' + name + '" already exists.');
      nameInput.focus();
      nameInput.select();
      return;
    }

    const projectId = buildManualProjectId(name);
    const projectState = ensureProjectState(projectId, name);
    touchProject(projectState);
    schedulePersist("Saving changes...");
    nameInput.value = "";
    closeCreateProjectPanel();
    openProject(projectId);
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
    const task = projectState.tasks[taskId];
    if (!task) {
      renderCurrentScreen();
      return;
    }

    const timestamp = nowIso();
    delete projectState.tasks[taskId];
    projectState.deletedTaskIds[taskId] = timestamp;
    projectState.archived[taskId] = {
      ...task,
      completedAt: timestamp,
      updatedAt: timestamp,
    };
    touchProject(projectState, timestamp);
    schedulePersist("Saving changes...");
    renderCurrentScreen();
  }

  function openEditModal(taskId) {
    const task = getActiveTask(taskId);
    if (!task) return;

    editTaskId = taskId;
    configureTaskDateInput("edit-task-date-input");
    $("#edit-task-name-input").value = task.name || "";
    $("#edit-task-description-input").value = task.description || "";
    $("#edit-task-date-input").value = task.dueDate || "";
    $("#edit-modal").classList.remove("hidden");
    $("#edit-modal").setAttribute("aria-hidden", "false");
  }

  function closeEditModal() {
    editTaskId = null;
    $("#edit-modal").classList.add("hidden");
    $("#edit-modal").setAttribute("aria-hidden", "true");
  }

  function getDefaultAddTaskDate() {
    return selectedTaskView === "day" && isDateKey(selectedDate) ? selectedDate : "";
  }

  function openAddTaskModal() {
    if (!currentProjectId) return;
    $("#add-task-name-input").value = "";
    $("#add-task-description-input").value = "";
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

    const timestamp = nowIso();
    task.name = name;
    task.description = description;
    task.dueDate = dueDate;
    task.updatedAt = timestamp;
    touchProject(projectState, timestamp);
    schedulePersist("Saving changes...");

    closeEditModal();
    renderCurrentScreen();
  }

  function populateDeferSelect() {
    const select = $("#defer-date-select");
    select.innerHTML = "";

    getDeferDates().forEach((dateKey) => {
      const option = document.createElement("option");
      option.value = dateKey;
      option.textContent = formatDateLong(dateKey);
      select.appendChild(option);
    });
  }

  function openDeferModal(taskId) {
    if (!currentProjectId) return;
    const task = getProjectState(currentProjectId).tasks[taskId];
    if (!task) return;

    deferTaskId = taskId;
    populateDeferSelect();
    $("#defer-task-name").textContent = task.name;
    $("#defer-modal").classList.remove("hidden");
    $("#defer-modal").setAttribute("aria-hidden", "false");
  }

  function closeDeferModal() {
    deferTaskId = null;
    $("#defer-modal").classList.add("hidden");
    $("#defer-modal").setAttribute("aria-hidden", "true");
  }

  function confirmDeferTask() {
    if (!currentProjectId || !deferTaskId) return;
    const projectState = ensureProjectState(currentProjectId, "");
    const task = projectState.tasks[deferTaskId];
    if (!task) {
      closeDeferModal();
      return;
    }

    const nextDate = $("#defer-date-select").value;
    if (!isDateKey(nextDate)) return;

    const timestamp = nowIso();
    task.dueDate = nextDate;
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
    delete projectState.tasks[taskId];
    projectState.deletedTaskIds[taskId] = timestamp;
    touchProject(projectState, timestamp);
    schedulePersist("Saving changes...");
    renderCurrentScreen();
  }

  function deleteArchivedTask(taskId) {
    if (!currentProjectId) return;
    const projectState = ensureProjectState(currentProjectId, "");
    const task = projectState.archived[taskId];
    if (!task) return;

    if (!confirm('Delete archived task "' + task.name + '"?')) return;

    const timestamp = nowIso();
    delete projectState.archived[taskId];
    projectState.deletedArchiveIds[taskId] = timestamp;
    touchProject(projectState, timestamp);
    schedulePersist("Saving changes...");
    renderArchiveScreen();
  }

  function clearArchive() {
    if (!currentProjectId) return;
    const projectState = ensureProjectState(currentProjectId, "");
    const archiveIds = Object.keys(projectState.archived);
    if (!archiveIds.length) return;

    if (!confirm("Delete the entire archive for this project?")) return;

    const timestamp = nowIso();
    archiveIds.forEach((taskId) => {
      delete projectState.archived[taskId];
      projectState.deletedArchiveIds[taskId] = timestamp;
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
    $("#open-create-project-btn").addEventListener("click", openCreateProjectPanel);
    $("#open-create-project-btn").addEventListener("pointerup", openCreateProjectPanel);
    $("#cancel-create-project-btn").addEventListener("click", closeCreateProjectPanel);
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
    $("#open-day-add-task-btn").addEventListener("click", () => {
      openAddTaskModal();
    });
    $("#refresh-project-btn").addEventListener("click", refreshCurrentProject);
    $("#refresh-day-project-btn").addEventListener("click", refreshCurrentProject);
    $("#download-active-btn").addEventListener("click", downloadActiveTasks);
    $("#view-archive-btn").addEventListener("click", openArchive);
    $("#back-project-btn").addEventListener("click", () => {
      renderDayView();
    });
    $("#download-archive-btn").addEventListener("click", downloadArchiveTasks);
    $("#delete-archive-btn").addEventListener("click", clearArchive);
    $("#create-project-form").addEventListener("submit", createManualProject);
    $("#cancel-add-task-btn").addEventListener("click", closeAddTaskModal);
    $("#add-task-form").addEventListener("submit", submitAddTask);
    $("#cancel-defer-btn").addEventListener("click", closeDeferModal);
    $("#confirm-defer-btn").addEventListener("click", confirmDeferTask);
    $("#cancel-edit-btn").addEventListener("click", closeEditModal);
    $("#edit-task-form").addEventListener("submit", saveEditedTask);
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
      renderHome();
      showScreen("home");
      return;
    }

    appEntered = true;
    loadLocalState();
    await loadManifest();
    await loadProjectConfigs();

    if (currentUser) {
      await pullState();
    }

    const stateChanged = ensureManifestProjectsInState();
    const generation = generateTasksForAllProjects();

    showUserBar();

    const defaultId = appState.defaultProjectId;
    if (defaultId && getProjectMeta(defaultId)) {
      currentProjectId = defaultId;
      renderHome();
      openDay(todayKey());
    } else {
      renderHome();
      showScreen("home");
    }

    if (stateChanged || generation.changed) {
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

  init();
})();
