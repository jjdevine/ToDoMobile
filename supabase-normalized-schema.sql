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
  default_project_updated_at timestamptz not null default now(),
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
  last_generated_through date,
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
-- 2B. TAGS TABLES
-- ============================================================================
create table if not exists todo.tags (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  tag         text        not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, tag),
  constraint tags_tag_not_blank check (length(btrim(tag)) > 0)
);

create table if not exists todo.project_tags (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  project_id  text        not null,
  tag         text        not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, project_id, tag),
  foreign key (user_id, project_id) references todo.projects(user_id, id) on delete cascade,
  foreign key (user_id, tag) references todo.tags(user_id, tag) on delete cascade
);

create index if not exists idx_project_tags_user_project
  on todo.project_tags (user_id, project_id);

create index if not exists idx_project_tags_user_tag
  on todo.project_tags (user_id, tag);

create or replace function todo.set_tags_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_tags_updated_at on todo.tags;

create trigger trg_tags_updated_at
before update on todo.tags
for each row execute function todo.set_tags_updated_at();

alter table todo.tags enable row level security;
alter table todo.project_tags enable row level security;

drop policy if exists "Users can read own tags" on todo.tags;
drop policy if exists "Users can insert own tags" on todo.tags;
drop policy if exists "Users can update own tags" on todo.tags;
drop policy if exists "Users can delete own tags" on todo.tags;

drop policy if exists "Users can read own project tags" on todo.project_tags;
drop policy if exists "Users can insert own project tags" on todo.project_tags;
drop policy if exists "Users can update own project tags" on todo.project_tags;
drop policy if exists "Users can delete own project tags" on todo.project_tags;

create policy "Users can read own tags"
  on todo.tags for select
  using (auth.uid() = user_id);

create policy "Users can insert own tags"
  on todo.tags for insert
  with check (auth.uid() = user_id);

create policy "Users can update own tags"
  on todo.tags for update
  using (auth.uid() = user_id);

create policy "Users can delete own tags"
  on todo.tags for delete
  using (auth.uid() = user_id);

create policy "Users can read own project tags"
  on todo.project_tags for select
  using (auth.uid() = user_id);

create policy "Users can insert own project tags"
  on todo.project_tags for insert
  with check (auth.uid() = user_id);

create policy "Users can update own project tags"
  on todo.project_tags for update
  using (auth.uid() = user_id);

create policy "Users can delete own project tags"
  on todo.project_tags for delete
  using (auth.uid() = user_id);

-- ============================================================================
-- 3. TASKS TABLE
-- ============================================================================
create table if not exists todo.tasks (
  user_id       uuid        not null references auth.users(id) on delete cascade,
  project_id    text        not null,
  id            text        not null,
  name          text        not null default '',
  due_date      date,
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
  due_date      date,
  source        text        not null default 'manual',
  generated_key text,
  pinned        boolean     not null default false,
  end_of_day    boolean     not null default false,
  body          text        not null default '',
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
  due_date        date,
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
-- 7. PROJECT_TOMBSTONES TABLE
-- ============================================================================
-- Records project deletions so they can be merged across devices without
-- allowing stale copies to recreate deleted projects.
create table if not exists todo.project_tombstones (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  project_id  text        not null,
  deleted_at  timestamptz not null,
  primary key (user_id, project_id)
);

alter table todo.project_tombstones enable row level security;

drop policy if exists "Users can read own project tombstones" on todo.project_tombstones;
drop policy if exists "Users can insert own project tombstones" on todo.project_tombstones;
drop policy if exists "Users can update own project tombstones" on todo.project_tombstones;
drop policy if exists "Users can delete own project tombstones" on todo.project_tombstones;

create policy "Users can read own project tombstones"
  on todo.project_tombstones for select
  using (auth.uid() = user_id);

create policy "Users can insert own project tombstones"
  on todo.project_tombstones for insert
  with check (auth.uid() = user_id);

create policy "Users can update own project tombstones"
  on todo.project_tombstones for update
  using (auth.uid() = user_id);

create policy "Users can delete own project tombstones"
  on todo.project_tombstones for delete
  using (auth.uid() = user_id);

-- ============================================================================
-- 8. SERVER-AUTHORITATIVE WORKFLOWS
-- ============================================================================
create or replace function todo.complete_task(p_project_id text, p_task_id text)
returns void
language plpgsql
security invoker
set search_path = todo, public
as $$
declare
  affected_rows integer;
begin
  insert into todo.archived_tasks (
    user_id, project_id, id, name, due_date, source, generated_key, pinned,
    end_of_day, body, completed_at, created_at, updated_at
  )
  select
    user_id, project_id, id, name, due_date, source, generated_key, pinned,
    end_of_day, body, now(), created_at, now()
  from todo.tasks
  where user_id = auth.uid() and project_id = p_project_id and id = p_task_id
  on conflict (user_id, project_id, id) do update
  set name = excluded.name,
      due_date = excluded.due_date,
      source = excluded.source,
      generated_key = excluded.generated_key,
      pinned = excluded.pinned,
      end_of_day = excluded.end_of_day,
      body = excluded.body,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at;

  get diagnostics affected_rows = row_count;
  if affected_rows <> 1 then
    raise exception 'Task not found';
  end if;

  delete from todo.tasks
  where user_id = auth.uid() and project_id = p_project_id and id = p_task_id;
end;
$$;

create or replace function todo.complete_tasks(p_project_id text, p_task_ids text[])
returns integer
language plpgsql
security invoker
set search_path = todo, public
as $$
declare
  task_id text;
  completed_count integer := 0;
begin
  foreach task_id in array coalesce(p_task_ids, array[]::text[])
  loop
    perform todo.complete_task(p_project_id, task_id);
    completed_count := completed_count + 1;
  end loop;
  return completed_count;
end;
$$;

create or replace function todo.generate_recurring_tasks(
  p_project_id text,
  p_generated_through text,
  p_candidates jsonb
)
returns integer
language plpgsql
security invoker
set search_path = todo, public
as $$
declare
  candidate record;
  occurrence_inserted integer;
  created_count integer := 0;
begin
  if not exists (
    select 1 from todo.projects
    where user_id = auth.uid() and id = p_project_id and inactive = false
  ) then
    raise exception 'Active project not found';
  end if;

  for candidate in
    select * from jsonb_to_recordset(coalesce(p_candidates, '[]'::jsonb)) as item(
      id text, name text, body text, due_date text, generated_key text
    )
  loop
    insert into todo.generated_occurrences (
      user_id, project_id, occurrence_key, task_id, due_date, task_name, created_at
    ) values (
      auth.uid(), p_project_id, candidate.generated_key, candidate.id,
      candidate.due_date, candidate.name, now()
    )
    on conflict (user_id, project_id, occurrence_key) do nothing;

    get diagnostics occurrence_inserted = row_count;
    if occurrence_inserted = 1 then
      insert into todo.tasks (
        user_id, project_id, id, name, due_date, source, generated_key,
        pinned, end_of_day, body, created_at, updated_at
      ) values (
        auth.uid(), p_project_id, candidate.id, candidate.name, candidate.due_date,
        'generated', candidate.generated_key, false, false,
        coalesce(candidate.body, ''), now(), now()
      );
      created_count := created_count + 1;
    end if;
  end loop;

  update todo.projects
  set last_generated_through = p_generated_through
  where user_id = auth.uid() and id = p_project_id;

  return created_count;
end;
$$;

revoke all on function todo.complete_task(text, text) from public;
revoke all on function todo.complete_tasks(text, text[]) from public;
revoke all on function todo.generate_recurring_tasks(text, text, jsonb) from public;
grant execute on function todo.complete_task(text, text) to authenticated;
grant execute on function todo.complete_tasks(text, text[]) to authenticated;
grant execute on function todo.generate_recurring_tasks(text, text, jsonb) to authenticated;

-- ============================================================================
-- Grant table-level permissions
-- ============================================================================
grant select, insert, update, delete on all tables in schema todo to anon, authenticated, service_role;
