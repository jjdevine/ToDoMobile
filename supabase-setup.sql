-- Run this in your Supabase SQL editor.

create schema if not exists todo;
grant usage on schema todo to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema todo to anon, authenticated, service_role;
alter default privileges in schema todo grant select, insert, update, delete on tables to anon, authenticated, service_role;

create table if not exists todo.todo_state (
  user_id uuid references auth.users(id) on delete cascade primary key,
  state_data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table todo.todo_state enable row level security;

drop policy if exists "Users can read own todo state" on todo.todo_state;
drop policy if exists "Users can insert own todo state" on todo.todo_state;
drop policy if exists "Users can update own todo state" on todo.todo_state;

create policy "Users can read own todo state"
  on todo.todo_state for select
  using (auth.uid() = user_id);

create policy "Users can insert own todo state"
  on todo.todo_state for insert
  with check (auth.uid() = user_id);

create policy "Users can update own todo state"
  on todo.todo_state for update
  using (auth.uid() = user_id);
