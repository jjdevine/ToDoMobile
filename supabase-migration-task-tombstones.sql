-- Migration: task_tombstones table
-- Run this in your Supabase SQL editor to enable deletion sync across devices.
--
-- Background: when a task is deleted on one device, a tombstone record is written
-- to this table. Other devices fetch these tombstones during sync and use them to
-- remove locally-cached copies of deleted tasks, ensuring deletions propagate
-- correctly across all devices.

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

grant select, insert, update, delete on todo.task_tombstones to anon, authenticated, service_role;
