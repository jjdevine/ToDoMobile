# Migration: Consolidate task_descriptions and project_configs into todo Schema

## Overview

This migration consolidates the remaining tables in the `public` schema (`task_descriptions` and `project_configs`) into the `todo` schema by merging their data into the parent tables (`todo.tasks` and `todo.projects` respectively).

**Objective:** Unify all application tables under the `todo` schema, eliminating the public schema as a data store.

**Data Consolidation Strategy:**
- `public.project_configs` → merge into `todo.projects` (add `config_text` column)
- `public.task_descriptions` → merge into `todo.tasks` (add `body` column)

**Impact:** 
- Single schema (`todo`) for all app data
- Simpler queries (no schema qualification needed after migration)
- Improved referential integrity (direct foreign keys instead of orphan management)

---

## Phase 1: Schema Extension

Add columns to existing todo schema tables to accommodate consolidated data.

### Step 1a: Add config_text to todo.projects

```sql
ALTER TABLE todo.projects
ADD COLUMN config_text text NOT NULL DEFAULT '';
```

**Rationale:** 
- Stores the recurring task configuration text for each project
- Default empty string allows app to function before data migration
- Nullable would be simpler, but NOT NULL with default maintains current data semantics

### Step 1b: Add body to todo.tasks

```sql
ALTER TABLE todo.tasks
ADD COLUMN body text NOT NULL DEFAULT '';
```

**Rationale:**
- Stores the long-form task description text
- Kept separate from `name` to avoid inflating the main task record unnecessarily
- Default empty string maintains backward compatibility

---

## Phase 2: Data Migration

Migrate existing data from public schema tables into the consolidated columns.

### Step 2a: Migrate project_configs data

```sql
UPDATE todo.projects tp
SET config_text = pc.config_text,
    updated_at = pc.updated_at
FROM public.project_configs pc
WHERE tp.user_id = pc.user_id
  AND tp.id = pc.project_id;
```

**Validation Query** (run after migration to verify all rows were copied):
```sql
SELECT 
  COUNT(*) as total_configs,
  COUNT(CASE WHEN config_text != '' THEN 1 END) as non_empty_configs,
  COUNT(CASE WHEN config_text = '' THEN 1 END) as empty_configs
FROM todo.projects;
```

### Step 2b: Migrate task_descriptions data

```sql
UPDATE todo.tasks tt
SET body = td.body,
    updated_at = td.updated_at
FROM public.task_descriptions td
WHERE tt.user_id = td.user_id
  AND tt.id = td.task_id;
```

**Validation Query** (run after migration to verify all rows were copied):
```sql
SELECT 
  COUNT(*) as total_tasks,
  COUNT(CASE WHEN body != '' THEN 1 END) as non_empty_descriptions,
  COUNT(CASE WHEN body = '' THEN 1 END) as empty_descriptions
FROM todo.tasks;
```

---

## Phase 3: RLS Policy Review

No changes required to RLS policies. The `user_id` column is already present in both parent tables and the existing policies (`auth.uid() = user_id`) cover the consolidated columns automatically.

**Verification:** Existing queries to `todo.projects` and `todo.tasks` already enforce RLS; the new columns inherit that protection.

---

## Phase 4: Verification and Cleanup

### Step 4a: Verify data completeness

Run these queries to ensure no data was lost during migration:

```sql
-- Check project_configs
SELECT 
  'public.project_configs' as source_table,
  COUNT(*) as public_rows,
  (SELECT COUNT(*) FROM todo.projects WHERE config_text != '') as migrated_rows
FROM public.project_configs;

-- Check task_descriptions
SELECT 
  'public.task_descriptions' as source_table,
  COUNT(*) as public_rows,
  (SELECT COUNT(*) FROM todo.tasks WHERE body != '') as migrated_rows
FROM public.task_descriptions
where body != '';
```

All row counts should match.

### Step 4b: Archive public schema tables (optional)

If verification passes, consider your archival strategy:

**Option 1: Drop tables immediately**
```sql
DROP TABLE public.project_configs;
DROP TABLE public.task_descriptions;
```

**Option 2: Keep as read-only archive temporarily**
```sql
ALTER TABLE public.project_configs OWNER TO read_only_role;
REVOKE INSERT, UPDATE, DELETE ON public.project_configs FROM authenticated;

ALTER TABLE public.task_descriptions OWNER TO read_only_role;
REVOKE INSERT, UPDATE, DELETE ON public.task_descriptions FROM authenticated;
```

**Recommendation:** Drop tables after app has been running with new schema for 1-2 weeks and no data loss is observed.

### Step 4c: Update API exposure (if using PostgREST)

If using Supabase's PostgREST API, verify that:
1. `public` schema is no longer exposed (or contains no tables)
2. `todo` schema is exposed and accessible to authenticated users

Check Supabase dashboard → "API" → "Schemas" section.

---

## Phase 5: Application Code Verification

After migration, verify that the application continues to function correctly:

### App.js Updates Required: NONE

The application code is already prepared:
- Lines 1117-1191: Task description CRUD already uses `todo.tasks` (via `.schema("todo").from(DESCRIPTIONS_TABLE)`)
- Lines 1370-1428: Project config CRUD already uses `todo.projects` (via `.schema("todo").from(PROJECT_CONFIGS_TABLE)`)

**However**, these queries need adjustment after migration:

**Task Descriptions:**
- Current: `.schema("todo").from(DESCRIPTIONS_TABLE)` → expects separate table
- After: Query should update `todo.tasks.body` directly within task row

**Project Configs:**
- Current: `.schema("todo").from(PROJECT_CONFIGS_TABLE)` → expects separate table  
### Queries to Update in app.js:

**Before (current, will fail after migration):**
```javascript
  .schema("todo")
  .from(DESCRIPTIONS_TABLE)  // This table doesn't exist after DROP
  .eq("task_id", taskId);
```

**After (correct, queries parent table):**
```javascript
// Correct after consolidation — queries merged column
const { data, error } = await supabaseClient
  .schema("todo")
  .from("tasks")
  .select("body")
  .eq("user_id", userId)
  .eq("id", taskId);
```

Same pattern applies to project_configs → projects.config_text.

---

## Execution Sequence

1. **Backup current data** (Supabase dashboard → Backups → Create backup)
2. Run Phase 1 (schema extension) — **1-2 minutes**
3. Run Phase 2 (data migration) — **1-5 minutes** depending on data size
4. Run Phase 4a (verification) — **< 1 minute**
5. **Deploy app.js updates** to handle consolidated queries
6. Run Phase 4b and 4c (cleanup) — **optional, 1 minute**

---

## Rollback Plan
1. **Rollback Phase 1 & 2:**
   ```sql
   ```


3. **Restore from backup** if data was corrupted (Supabase dashboard)

## Testing Checklist

- [ ] Run Phase 1 schema extension on staging environment
- [ ] Run Phase 2 data migration
- [ ] Verify data counts in Phase 4a
- [ ] Test project config read/write in app (create, edit, delete project)
- [ ] Test task description read/write in app (add body to task, edit, delete)
- [ ] Verify RLS still protects user data (user A cannot see user B's configs/descriptions)
- [ ] Check service worker version is bumped (cache invalidation)
- [ ] Test offline sync behavior (make changes offline, sync when online)
- [ ] Verify no orphaned rows in public tables after Phase 2
- [ ] Confirm POST REST API no longer exposes public schema tables

---

## Dependencies & Timing

- **Database:** Must execute full Phase 1 & 2 before app code changes
- **App Code:** Must update to query merged columns before Phase 4b (dropping public tables)
- **Service Worker:** Cache version must bump when app.js changes to force client refresh
- **User Impact:** Migration is non-disruptive; existing queries work during Phase 1 & 2

---

## Summary

| Phase | Action | Risk | Time |
|-------|--------|------|------|
| 1 | Add columns to existing tables | Very Low | 1-2 min |
| 2 | Copy data from public tables | Very Low (non-destructive) | 1-5 min |
| 3 | RLS review | Very Low (no changes) | 0 min |
| 4a | Verify migration | Very Low (read-only) | < 1 min |
| 4b | Drop public tables | Very Low (but permanent) | 1 min |
| 4c | Update API exposure | Very Low (config only) | 1 min |
| 5 | Update app.js queries | Medium (app-side logic change) | 15-30 min development |

**Total Database Execution Time:** ~5 minutes  
**Total Development Time (app.js updates):** ~30 minutes
