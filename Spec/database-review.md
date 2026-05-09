# Database Structure Review

This document reviews the suitability of the current Supabase database schema used by
the Task Planner application, identifies risks, and proposes a normalized replacement
schema together with a safe, zero-data-loss migration plan.

---

## 1. Current Schema

The application uses three tables in a Supabase (PostgreSQL) project.

### 1.1 `todo_state`

```sql
create table todo.todo_state (
  user_id    uuid        references auth.users(id) on delete cascade primary key,
  state_data jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
```

**One row per user.** The `state_data` column holds the entire application state as a
single JSONB object. Its logical shape (derived from `app.js`) is:

```jsonc
{
  "version": 1,
  "updatedAt": "<ISO timestamp>",
  "defaultProjectId": "<project id or null>",
  "deletedProjectIds": {
    "<project_id>": "<ISO deletion timestamp>"
    // ... project tombstones for merge conflict resolution
  },
  "projects": {
    "<project_id>": {
      "projectId": "<project_id>",
      "name": "...",
      "inactive": false,
      "lastGeneratedThrough": "<YYYY-MM-DD or null>",
      "updatedAt": "<ISO timestamp>",
      "tasks": {
        "<task_id>": {
          "id": "...", "name": "...", "description": "...",
          "dueDate": "<YYYY-MM-DD or null>",
          "source": "manual | generated",
          "generatedKey": "<string or null>",
          "pinned": false,
          "createdAt": "...", "updatedAt": "..."
        }
        // ... one entry per active task
      },
      "archived": {
        "<task_id>": { /* same shape as tasks, plus "completedAt" */ }
        // ... one entry per completed task (grows forever)
      },
      "generatedOccurrences": {
        "<occurrence_key>": {
          "createdAt": "...", "taskId": "...",
          "dueDate": "...", "taskName": "..."
        }
        // ... one entry per generated task occurrence ever created
      },
      "deletedTaskIds": {
        "<task_id>": "<ISO deletion timestamp>"
        // ... tombstones for merge conflict resolution
      },
      "deletedArchiveIds": {
        "<task_id>": "<ISO deletion timestamp>"
      }
    }
    // ... one entry per project
  }
}
```

### 1.2 `task_descriptions`

```sql
create table todo.task_descriptions (
  task_id    text        not null,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  body       text        not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, task_id)
);
```

**One row per task per user.** Long-form task description text was extracted from the
JSONB blob into this dedicated table so that large descriptions do not inflate the main
state payload on every sync.

### 1.3 `project_configs`

```sql
create table todo.project_configs (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  project_id text        not null,
  config_text text       not null default '',
  updated_at  timestamptz not null default now(),
  primary key (user_id, project_id)
);
```

**One row per project per user.** Recurring-task configuration text was also extracted
from the blob.

### 1.4 Row Level Security

All three tables have RLS enabled. Users can only read and write their own rows.
`task_descriptions` and `project_configs` additionally allow per-row deletion.
`todo_state` has no delete policy — rows are only removed via the `auth.users` cascade.

---

## 2. Suitability Analysis

### 2.1 What works well

| Aspect | Assessment |
|---|---|
| Row-level security | Strong: every table is protected and each policy is correct. |
| Authentication integration | `auth.users` FK with `on delete cascade` ensures clean data removal when a user account is deleted. |
| Offline / sync model | The single-blob approach simplifies offline-first development: the whole state is one object in `localStorage` and one row in Supabase. |
| Partial extraction | `task_descriptions` and `project_configs` show awareness of the blob's limitations and demonstrate a path toward normalization. |

### 2.2 Risks and problems

#### 2.2.1 Unbounded blob growth

The `state_data` blob grows in four independent dimensions, **none of which is bounded**:

* **Active tasks** — accumulate as users add projects.
* **Archived tasks** — completed tasks are moved into `archived` and are never pruned.
  A user who completes one task per day for two years will accumulate ~730 archived task
  objects, each containing at least 10 JSON fields.
* **Generated occurrences** — every time a recurring task is generated, an entry is
  appended to `generatedOccurrences`. A project with five daily tasks generates ~1,825
  entries per year; this map is never trimmed.
* **Tombstones** (`deletedProjectIds`, `deletedTaskIds`, `deletedArchiveIds`) —
  deletion records are kept forever to support merge conflict resolution across
  devices. They accumulate without any expiry.

A power user with many projects and years of history could easily exceed **1–5 MB per
row**. PostgreSQL stores large JSONB values via its TOAST mechanism (transparent
out-of-line storage), which adds read overhead and increases backup/replication costs.

#### 2.2.2 Full-blob writes on every save

Every save — triggered two seconds after any change — replaces the entire `state_data`
column for the user's row via an `upsert`. Even a one-character task name edit rewrites
megabytes of data. This causes:

* High network bandwidth consumption on mobile devices.
* Unnecessary Supabase write quota usage.
* Higher latency for users on slow connections, worsening the offline experience.

#### 2.2.3 No queryability

Individual tasks cannot be queried, filtered, or sorted at the database level.
Consequences include:

* No ability to list overdue tasks across all users (e.g. for admin tooling or analytics).
* No ability to add full-text search without loading the entire blob into memory.
* Any future reporting, data export, or cross-project feature must parse the blob
  client-side.

#### 2.2.4 No data integrity enforcement

Because tasks, projects, and occurrences are arbitrary JSON keys inside a blob,
PostgreSQL cannot enforce:

* Referential integrity between tasks and projects.
* `NOT NULL` constraints on task names.
* `CHECK` constraints on `source` fields or date formats.
* Uniqueness of task IDs within a project.

#### 2.2.5 Merge conflict model is fragile

The app implements last-write-wins merging at the task level using `updatedAt`
timestamps. Tombstones are used to suppress resurrection of deleted tasks. This model
has known edge cases:

* Clock skew between devices can cause older data to win.
* Tombstones accumulate forever; there is no safe point at which they can be purged.
* Concurrent edits to two different tasks in the same project both update the top-level
  `updatedAt`, potentially causing one device's changes to be dropped when the other
  device pushes first.

#### 2.2.6 Inconsistency between tables

`task_descriptions` and `project_configs` are properly normalized, while `todo_state`
is a blob. This creates a dual-source-of-truth problem: when a user deletes a task, the
app must separately delete the row in `task_descriptions`. Missed deletions accumulate
as orphaned rows. Similarly, project deletion should cascade to `project_configs` but
the app must handle this explicitly.

---

## 3. Proposed Normalized Schema

The following schema replaces `todo_state` with purpose-built tables. The existing
`task_descriptions` and `project_configs` tables are retained unchanged.

```sql
create schema if not exists todo;

-- User-level settings (replaces defaultProjectId in the blob)
create table todo.user_settings (
  user_id            uuid        primary key references auth.users(id) on delete cascade,
  default_project_id text,
  updated_at         timestamptz not null default now()
);

-- Projects
create table todo.projects (
  id         text        not null,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  name       text        not null default '',
  inactive   boolean     not null default false,
  last_generated_through date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Active tasks
create table todo.tasks (
  id            text        not null,
  user_id       uuid        not null references auth.users(id) on delete cascade,
  project_id    text        not null,
  name          text        not null default '',
  due_date      date,
  source        text        not null default 'manual'
                  check (source in ('manual', 'generated')),
  generated_key text,
  pinned        boolean     not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, project_id, id),
  foreign key (user_id, project_id) references todo.projects(user_id, id)
    on delete cascade
);

-- Archived (completed) tasks
create table todo.archived_tasks (
  id            text        not null,
  user_id       uuid        not null references auth.users(id) on delete cascade,
  project_id    text        not null,
  name          text        not null default '',
  due_date      date,
  source        text        not null default 'manual'
                  check (source in ('manual', 'generated')),
  generated_key text,
  pinned        boolean     not null default false,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, project_id, id),
  foreign key (user_id, project_id) references todo.projects(user_id, id)
    on delete cascade
);

-- Generated occurrence tracking
create table todo.generated_occurrences (
  occurrence_key text        not null,
  user_id        uuid        not null references auth.users(id) on delete cascade,
  project_id     text        not null,
  task_id        text,
  due_date       date,
  task_name      text        not null default '',
  created_at     timestamptz not null default now(),
  primary key (user_id, project_id, occurrence_key),
  foreign key (user_id, project_id) references todo.projects(user_id, id)
    on delete cascade
);
```

### 3.1 What changes

| Before | After |
|---|---|
| Single `todo_state` row with a JSONB blob per user | Separate rows per project, task, archived task, and occurrence |
| No foreign keys between logical entities | Full referential integrity; deleting a project cascades to all its tasks |
| No database-level constraints on task fields | `NOT NULL`, `CHECK`, and FK constraints enforced by PostgreSQL |
| Full-blob replace on every save | Row-level `upsert` / `delete` per changed entity |
| Tombstones required for merge conflict resolution | Deletes are permanent; no tombstones needed |
| `task_descriptions` inconsistently separate | Keep table initially, then add `project_id` and FK to `tasks(user_id, project_id, id)` |

### 3.2 What stays the same

* `task_descriptions` — keep as-is initially to reduce migration risk; then add
  `project_id` and a FK to `tasks(user_id, project_id, id)` after app writes to
  normalized task rows.
* `project_configs` — already normalized; no changes required.
* RLS pattern — each new table uses the same `auth.uid() = user_id` pattern.
* Offline-first model — the app can continue to use `localStorage` for local state and
  sync individual changed rows rather than the entire blob.

### 3.3 Suggested indexes

```sql
-- Speed up per-user project listing
create index on todo.projects(user_id);

-- Speed up active task queries by due date (overdue view, day view)
create index on todo.tasks(user_id, due_date);

-- Speed up archive queries
create index on todo.archived_tasks(user_id, project_id, completed_at desc);
```

---

## 4. Migration Plan

The migration must preserve all existing user data. It is designed to be:

* **Non-destructive** — the `todo_state` table is kept in read-only mode during the
  transition and only dropped after validation.
* **Idempotent** — the migration SQL can be re-run safely.
* **Zero-downtime** — the new tables are created and populated before any app code
  switch-over.

### Phase 1 — Create new tables (no disruption)

Run the DDL from Section 3 above. Add RLS policies to every new table before enabling
RLS.

```sql
-- Example for projects (repeat pattern for all new tables)
alter table todo.projects enable row level security;

create policy "Users can read own projects"
  on todo.projects for select using (auth.uid() = user_id);

create policy "Users can insert own projects"
  on todo.projects for insert with check (auth.uid() = user_id);

create policy "Users can update own projects"
  on todo.projects for update using (auth.uid() = user_id);

create policy "Users can delete own projects"
  on todo.projects for delete using (auth.uid() = user_id);

-- Repeat for user_settings, tasks, archived_tasks, generated_occurrences
```

### Phase 2 — Back-fill data from the blob

The following SQL reads every row in `todo_state` and inserts the extracted data into
the new tables. It uses `on conflict do nothing` so it is safe to re-run.

```sql
-- -----------------------------------------------------------------------
-- 2a. user_settings
-- -----------------------------------------------------------------------
insert into todo.user_settings (user_id, default_project_id, updated_at)
select
  user_id,
  (state_data ->> 'defaultProjectId'),
  updated_at
from todo.todo_state
on conflict (user_id) do nothing;

-- -----------------------------------------------------------------------
-- 2b. projects
-- -----------------------------------------------------------------------
insert into todo.projects (user_id, id, name, inactive,
                              last_generated_through, updated_at)
select
  ts.user_id,
  proj.key                                             as id,
  proj.value ->> 'name'                                as name,
  coalesce((proj.value ->> 'inactive')::boolean, false) as inactive,
  (proj.value ->> 'lastGeneratedThrough')::date        as last_generated_through,
  coalesce(
    (proj.value ->> 'updatedAt')::timestamptz,
    ts.updated_at
  )                                                    as updated_at
from todo.todo_state ts,
     jsonb_each(ts.state_data -> 'projects') as proj(key, value)
on conflict (user_id, id) do nothing;

-- -----------------------------------------------------------------------
-- 2c. active tasks
-- -----------------------------------------------------------------------
insert into todo.tasks (user_id, project_id, id, name, due_date,
                           source, generated_key, pinned,
                           created_at, updated_at)
select
  ts.user_id,
  proj.key                                             as project_id,
  task.key                                             as id,
  coalesce(task.value ->> 'name', '')                  as name,
  (task.value ->> 'dueDate')::date                     as due_date,
  coalesce(
    case when task.value ->> 'source' in ('manual','generated')
         then task.value ->> 'source' end,
    'manual'
  )                                                    as source,
  task.value ->> 'generatedKey'                        as generated_key,
  coalesce((task.value ->> 'pinned')::boolean, false)  as pinned,
  coalesce(
    (task.value ->> 'createdAt')::timestamptz,
    ts.updated_at
  )                                                    as created_at,
  coalesce(
    (task.value ->> 'updatedAt')::timestamptz,
    ts.updated_at
  )                                                    as updated_at
from todo.todo_state ts,
     jsonb_each(ts.state_data -> 'projects') as proj(key, value),
     jsonb_each(proj.value -> 'tasks')        as task(key, value)
where task.value ->> 'name' is not null
  and task.value ->> 'name' <> ''
on conflict (user_id, project_id, id) do nothing;

-- -----------------------------------------------------------------------
-- 2d. archived tasks
-- -----------------------------------------------------------------------
insert into todo.archived_tasks (user_id, project_id, id, name, due_date,
                                    source, generated_key, pinned,
                                    completed_at, created_at, updated_at)
select
  ts.user_id,
  proj.key                                              as project_id,
  task.key                                              as id,
  coalesce(task.value ->> 'name', '')                   as name,
  (task.value ->> 'dueDate')::date                      as due_date,
  coalesce(
    case when task.value ->> 'source' in ('manual','generated')
         then task.value ->> 'source' end,
    'manual'
  )                                                     as source,
  task.value ->> 'generatedKey'                         as generated_key,
  coalesce((task.value ->> 'pinned')::boolean, false)   as pinned,
  (task.value ->> 'completedAt')::timestamptz           as completed_at,
  coalesce(
    (task.value ->> 'createdAt')::timestamptz,
    ts.updated_at
  )                                                     as created_at,
  coalesce(
    (task.value ->> 'updatedAt')::timestamptz,
    ts.updated_at
  )                                                     as updated_at
from todo.todo_state ts,
     jsonb_each(ts.state_data -> 'projects')   as proj(key, value),
     jsonb_each(proj.value -> 'archived')       as task(key, value)
where task.value ->> 'name' is not null
  and task.value ->> 'name' <> ''
on conflict (user_id, project_id, id) do nothing;

-- -----------------------------------------------------------------------
-- 2e. generated occurrences
-- -----------------------------------------------------------------------
insert into todo.generated_occurrences (user_id, project_id, occurrence_key,
                                           task_id, due_date, task_name, created_at)
select
  ts.user_id,
  proj.key                                             as project_id,
  occ.key                                              as occurrence_key,
  occ.value ->> 'taskId'                               as task_id,
  (occ.value ->> 'dueDate')::date                      as due_date,
  coalesce(occ.value ->> 'taskName', '')               as task_name,
  coalesce(
    (occ.value ->> 'createdAt')::timestamptz,
    ts.updated_at
  )                                                    as created_at
from todo.todo_state ts,
     jsonb_each(ts.state_data -> 'projects')                 as proj(key, value),
     jsonb_each(proj.value -> 'generatedOccurrences')         as occ(key, value)
on conflict (user_id, project_id, occurrence_key) do nothing;
```

### Phase 3 — Validate

Run the following queries to confirm row counts match expectations before any app
code changes are deployed.

```sql
-- Compare project counts per user (blob vs normalized)
with blob_projects as (
  select
    ts.user_id,
    count(*) as blob_project_count
  from todo.todo_state ts
  cross join lateral jsonb_object_keys(coalesce(ts.state_data -> 'projects', '{}'::jsonb)) as proj_id
  group by ts.user_id
),
normalized_projects as (
  select
    user_id,
    count(*) as normalized_project_count
  from todo.projects
  group by user_id
)
select
  ts.user_id,
  coalesce(bp.blob_project_count, 0) as blob_project_count,
  coalesce(np.normalized_project_count, 0) as normalized_project_count
from todo.todo_state ts
left join blob_projects bp using (user_id)
left join normalized_projects np using (user_id)
order by ts.user_id;

-- Spot-check a single user (replace the UUID)
select * from todo.projects  where user_id = '<uuid>';
select * from todo.tasks     where user_id = '<uuid>' limit 20;
select * from todo.archived_tasks where user_id = '<uuid>' limit 20;
```

### Phase 4 — Update application code

Refactor `app.js` to read from and write to the new tables instead of the `todo_state`
blob. Key changes required:

* Replace `pushState()` with per-entity upserts (projects, tasks, archived tasks,
  occurrences).
* Replace `pullState()` with SELECT queries per table, assembled into the in-memory
  `appState` structure.
* Replace the `mergeStates()` tombstone logic with database-level deletes; concurrent
  delete-then-recreate conflicts are resolved by `updated_at` comparison on the row
  itself.
* Add `project_id` to `task_descriptions`, backfill it from migrated task rows, and
  then add an FK to `tasks(user_id, project_id, id)` so orphan descriptions are
  prevented.

Most of the in-memory `appState` object can remain unchanged during the transition,
but once normalized tables are the source of truth the tombstone maps
(`deletedProjectIds`, `deletedTaskIds`, `deletedArchiveIds`) and blob merge logic
should be retired from the sync path.

### Phase 5 — Remove write access to `todo_state`

Once the new code is deployed and confirmed stable, drop the insert/update RLS
policies on `todo_state` to make it read-only. This protects migrated data while
keeping the old table available for rollback.

```sql
drop policy if exists "Users can insert own todo state" on todo.todo_state;
drop policy if exists "Users can update own todo state" on todo.todo_state;
```

### Phase 6 — Drop `todo_state` (after soak period)

After a suitable soak period (e.g. two weeks) with no rollback incidents, drop the old
table.

```sql
drop table todo.todo_state;
```

---

## 5. Summary and Recommendation

| | Current (`todo_state` blob) | Proposed (normalized) |
|---|---|---|
| **Scalability** | ❌ Unbounded blob growth | ✅ Rows grow proportionally to data |
| **Write efficiency** | ❌ Full blob on every save | ✅ Only changed rows written |
| **Queryability** | ❌ None at database level | ✅ Full SQL, indexes, full-text search |
| **Data integrity** | ❌ No constraints | ✅ FK, NOT NULL, CHECK |
| **Consistency** | ⚠️ Dual source of truth with `task_descriptions` | ✅ Single normalized store |
| **Migration risk** | — | ✅ Low: non-destructive, idempotent, rollback available |

The current structure was a pragmatic starting point that enabled fast development of
the offline-first sync model. The extraction of `task_descriptions` and
`project_configs` into their own tables demonstrates the right direction. Completing
that normalization will eliminate the main scalability and integrity risks, and the
migration plan above ensures no existing user data is lost in the process.
