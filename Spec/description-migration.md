# Task Description Migration

## Background

Task descriptions were previously stored inside `todo_state.state_data` as `task.description` fields in the main JSON blob. This bloated the JSON payload and required loading descriptions even when they were not needed.

## New Architecture

Descriptions are now stored in a dedicated Supabase table (`task_descriptions`) with the following schema:

| Column       | Type        | Description                          |
|--------------|-------------|--------------------------------------|
| `task_id`    | text        | The task ID (matches `task.id`)      |
| `user_id`    | uuid        | Foreign key to `auth.users`          |
| `body`       | text        | The description text                 |
| `updated_at` | timestamptz | Last-updated timestamp               |

Row-level security ensures users can only access their own descriptions.

## Migration Approach

### One-Time Client-Side Migration (automatic)

On sign-in or first sync, the app automatically migrates existing descriptions:

1. Scan all tasks in `appState` (both active and archived) for a non-empty `task.description`.
2. For each task found, upsert the description into the `task_descriptions` table.
3. On successful upsert, delete `task.description` from the in-memory task object.
4. Save state locally and push to Supabase so the JSON no longer carries the description.
5. Record the migration as complete in `localStorage` (keyed by user ID) so it does not repeat on subsequent sign-ins.

Requests are throttled to a concurrency limit of 3 to avoid hammering Supabase. The migration is idempotent: upserts are safe to retry if interrupted.

### Ongoing Behavior (after migration)

- **Creating tasks**: descriptions are upserted to `task_descriptions`; the JSON task object has no `description` field.
- **Editing tasks**: the edit modal fetches the description from `task_descriptions` (with the legacy `task.description` as an immediate fallback while the fetch is in flight). On save, the description is upserted to `task_descriptions` and the `description` field is deleted from the task object.
- **Deleting tasks** (hard delete, archive delete, clear archive): the corresponding rows are deleted from `task_descriptions`.

## Effect on JSON Size

Because `task.description` is deleted from the task object once migrated (and never written for new tasks), the `state_data` JSON payload shrinks over time. Tasks that have never had a description simply never carry the field.

## Running the SQL

Run `supabase-setup.sql` in the Supabase SQL editor to create the `task_descriptions` table and its RLS policies. The script is idempotent (`create table if not exists`, `drop policy if exists`).
