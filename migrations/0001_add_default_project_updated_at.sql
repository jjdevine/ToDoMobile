-- Adds a dedicated timestamp for default project changes.
-- This prevents unrelated state updates from overriding default_project_id during merges.

alter table todo.user_settings
  add column if not exists default_project_updated_at timestamptz;

update todo.user_settings
set default_project_updated_at = coalesce(default_project_updated_at, updated_at, now())
where default_project_updated_at is null;

alter table todo.user_settings
  alter column default_project_updated_at set default now();

alter table todo.user_settings
  alter column default_project_updated_at set not null;
