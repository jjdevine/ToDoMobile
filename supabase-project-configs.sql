-- Run this in your Supabase SQL editor AFTER running supabase-setup.sql.
--
-- Creates a table to store one configuration text blob per user per project.
-- The configuration text follows the same format as the legacy Projects/*.txt
-- files: each line is either a comment (#...) or a task rule in the form
--   task name-weekly-day[,day...]
--   task name-monthly-dayOfMonth[,dayOfMonth...]
--   task name-annual-MM-DD
--
-- How to run:
--   1. Open your Supabase project → SQL Editor.
--   2. Paste the contents of this file and click Run.
--   3. Confirm the table and policies appear under Table Editor / Auth policies.

-- Ensure dedicated ToDo schema exists
create schema if not exists todo;

-- 1. Project config table (1:1 per user+project)
create table if not exists todo.project_configs (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  project_id  text        not null,
  config_text text        not null default '',
  updated_at  timestamptz not null default now(),
  primary key (user_id, project_id)
);

-- 2. Keep updated_at current on every update
create or replace function todo.set_project_configs_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_project_configs_updated_at on todo.project_configs;

create trigger trg_project_configs_updated_at
before update on todo.project_configs
for each row execute function todo.set_project_configs_updated_at();

-- 3. Row Level Security — users may only access their own rows
alter table todo.project_configs enable row level security;

drop policy if exists "Users can read own project configs"   on todo.project_configs;
drop policy if exists "Users can insert own project configs"  on todo.project_configs;
drop policy if exists "Users can update own project configs"  on todo.project_configs;
drop policy if exists "Users can delete own project configs"  on todo.project_configs;

create policy "Users can read own project configs"
  on todo.project_configs for select
  using (auth.uid() = user_id);

create policy "Users can insert own project configs"
  on todo.project_configs for insert
  with check (auth.uid() = user_id);

create policy "Users can update own project configs"
  on todo.project_configs for update
  using (auth.uid() = user_id);

create policy "Users can delete own project configs"
  on todo.project_configs for delete
  using (auth.uid() = user_id);
