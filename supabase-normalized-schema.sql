-- Normalized schema for ToDoMobile (definitive)
-- Run this in your Supabase SQL editor.
-- This script is self-contained and creates the full normalized schema.

-- Ensure schema permissions are set
create schema if not exists todo;
grant usage on schema todo to anon, authenticated, service_role;
alter default privileges in schema todo grant select, insert, update, delete on tables to anon, authenticated, service_role;

-- ============================================================================
-- 1. USER_SETTINGS TABLE
-- ============================================================================
create table if not exists todo.user_settings (
  user_id              uuid        not null references auth.users(id) on delete cascade primary key,
  default_project_id   text,
  updated_at           timestamptz not null default now()
);

alter table todo.user_settings enable row level security;

drop policy if exists "Users can read own user settings" on todo.user_settings;
drop policy if exists "Users can insert own user settings" on todo.user_settings;
drop policy if exists "Users can update own user settings" on todo.user_settings;

create policy "Users can read own user settings"
  on todo.user_settings for select
  using (auth.uid() = user_id);

create policy "Users can insert own user settings"
  on todo.user_settings for insert
  with check (auth.uid() = user_id);

create policy "Users can update own user settings"
  on todo.user_settings for update
  using (auth.uid() = user_id);

-- ============================================================================
-- 2. PROJECTS TABLE
-- ============================================================================
create table if not exists todo.projects (
  user_id                uuid        not null references auth.users(id) on delete cascade,
  id                     text        not null,
  name                   text        not null default '',
  inactive               boolean     not null default false,
  last_generated_through text,
  config_text            text        not null default '',
  updated_at             timestamptz not null default now(),
  primary key (user_id, id)
);

-- Keep updated_at current on every update
create or replace function todo.set_projects_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_projects_updated_at on todo.projects;

create trigger trg_projects_updated_at
before update on todo.projects
for each row execute function todo.set_projects_updated_at();

alter table todo.projects enable row level security;

drop policy if exists "Users can read own projects" on todo.projects;
drop policy if exists "Users can insert own projects" on todo.projects;
drop policy if exists "Users can update own projects" on todo.projects;
drop policy if exists "Users can delete own projects" on todo.projects;

create policy "Users can read own projects"
  on todo.projects for select
  using (auth.uid() = user_id);

create policy "Users can insert own projects"
  on todo.projects for insert
  with check (auth.uid() = user_id);

create policy "Users can update own projects"
  on todo.projects for update
  using (auth.uid() = user_id);

create policy "Users can delete own projects"
  on todo.projects for delete
  using (auth.uid() = user_id);

-- ============================================================================
-- 3. TASKS TABLE
-- ============================================================================
create table if not exists todo.tasks (
  user_id       uuid        not null references auth.users(id) on delete cascade,
  project_id    text        not null,
  id            text        not null,
  name          text        not null default '',
  due_date      text,
  source        text        not null default 'manual',
  generated_key text,
  pinned        boolean     not null default false,
  end_of_day    boolean     not null default false,
  body          text        not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, project_id, id),
  foreign key (user_id, project_id) references todo.projects(user_id, id) on delete cascade
);

create or replace function todo.set_tasks_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_tasks_updated_at on todo.tasks;

create trigger trg_tasks_updated_at
before update on todo.tasks
for each row execute function todo.set_tasks_updated_at();

alter table todo.tasks enable row level security;

drop policy if exists "Users can read own tasks" on todo.tasks;
drop policy if exists "Users can insert own tasks" on todo.tasks;
drop policy if exists "Users can update own tasks" on todo.tasks;
drop policy if exists "Users can delete own tasks" on todo.tasks;

create policy "Users can read own tasks"
  on todo.tasks for select
  using (auth.uid() = user_id);

create policy "Users can insert own tasks"
  on todo.tasks for insert
  with check (auth.uid() = user_id);

create policy "Users can update own tasks"
  on todo.tasks for update
  using (auth.uid() = user_id);

create policy "Users can delete own tasks"
  on todo.tasks for delete
  using (auth.uid() = user_id);

-- ============================================================================
-- 4. ARCHIVED_TASKS TABLE
-- ============================================================================
create table if not exists todo.archived_tasks (
  user_id       uuid        not null references auth.users(id) on delete cascade,
  project_id    text        not null,
  id            text        not null,
  name          text        not null default '',
  due_date      text,
  source        text        not null default 'manual',
  generated_key text,
  pinned        boolean     not null default false,
  end_of_day    boolean     not null default false,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, project_id, id),
  foreign key (user_id, project_id) references todo.projects(user_id, id) on delete cascade
);

create or replace function todo.set_archived_tasks_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_archived_tasks_updated_at on todo.archived_tasks;

create trigger trg_archived_tasks_updated_at
before update on todo.archived_tasks
for each row execute function todo.set_archived_tasks_updated_at();

alter table todo.archived_tasks enable row level security;

drop policy if exists "Users can read own archived tasks" on todo.archived_tasks;
drop policy if exists "Users can insert own archived tasks" on todo.archived_tasks;
drop policy if exists "Users can update own archived tasks" on todo.archived_tasks;
drop policy if exists "Users can delete own archived tasks" on todo.archived_tasks;

create policy "Users can read own archived tasks"
  on todo.archived_tasks for select
  using (auth.uid() = user_id);

create policy "Users can insert own archived tasks"
  on todo.archived_tasks for insert
  with check (auth.uid() = user_id);

create policy "Users can update own archived tasks"
  on todo.archived_tasks for update
  using (auth.uid() = user_id);

create policy "Users can delete own archived tasks"
  on todo.archived_tasks for delete
  using (auth.uid() = user_id);

-- ============================================================================
-- 5. GENERATED_OCCURRENCES TABLE
-- ============================================================================
create table if not exists todo.generated_occurrences (
  user_id         uuid        not null references auth.users(id) on delete cascade,
  project_id      text        not null,
  occurrence_key  text        not null,
  task_id         text,
  due_date        text,
  task_name       text        not null default '',
  created_at      timestamptz not null default now(),
  primary key (user_id, project_id, occurrence_key),
  foreign key (user_id, project_id) references todo.projects(user_id, id) on delete cascade
);

alter table todo.generated_occurrences enable row level security;

drop policy if exists "Users can read own generated occurrences" on todo.generated_occurrences;
drop policy if exists "Users can insert own generated occurrences" on todo.generated_occurrences;
drop policy if exists "Users can update own generated occurrences" on todo.generated_occurrences;
drop policy if exists "Users can delete own generated occurrences" on todo.generated_occurrences;

create policy "Users can read own generated occurrences"
  on todo.generated_occurrences for select
  using (auth.uid() = user_id);

create policy "Users can insert own generated occurrences"
  on todo.generated_occurrences for insert
  with check (auth.uid() = user_id);

create policy "Users can update own generated occurrences"
  on todo.generated_occurrences for update
  using (auth.uid() = user_id);

create policy "Users can delete own generated occurrences"
  on todo.generated_occurrences for delete
  using (auth.uid() = user_id);

-- ============================================================================
-- 6. TASK_TOMBSTONES TABLE
-- ============================================================================
-- Records each permanent task deletion so that the deletion propagates to all
-- other devices during sync. When a device deletes a task, a tombstone row is
-- written here. Other devices fetch these rows on pull and use them to remove
-- locally-cached copies, ensuring deletions are not silently reverted by the
-- "local wins when only local has it" merge rule.
create table if not exists todo.task_tombstones (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  project_id  text        not null,
  task_id     text        not null,
  is_archived boolean     not null default false,
  deleted_at  timestamptz not null,
  primary key (user_id, project_id, task_id, is_archived)
);

alter table todo.task_tombstones enable row level security;

drop policy if exists "Users can read own task tombstones" on todo.task_tombstones;
drop policy if exists "Users can insert own task tombstones" on todo.task_tombstones;
drop policy if exists "Users can update own task tombstones" on todo.task_tombstones;
drop policy if exists "Users can delete own task tombstones" on todo.task_tombstones;

create policy "Users can read own task tombstones"
  on todo.task_tombstones for select
  using (auth.uid() = user_id);

create policy "Users can insert own task tombstones"
  on todo.task_tombstones for insert
  with check (auth.uid() = user_id);

create policy "Users can update own task tombstones"
  on todo.task_tombstones for update
  using (auth.uid() = user_id);

create policy "Users can delete own task tombstones"
  on todo.task_tombstones for delete
  using (auth.uid() = user_id);

-- ============================================================================
-- Grant table-level permissions
-- ============================================================================
grant select, insert, update, delete on all tables in schema todo to anon, authenticated, service_role;
