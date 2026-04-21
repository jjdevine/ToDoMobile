-- Run this in your Supabase SQL editor.

create table if not exists todo_state (
  user_id uuid references auth.users(id) on delete cascade primary key,
  state_data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table todo_state enable row level security;

drop policy if exists "Users can read own todo state" on todo_state;
drop policy if exists "Users can insert own todo state" on todo_state;
drop policy if exists "Users can update own todo state" on todo_state;

create policy "Users can read own todo state"
  on todo_state for select
  using (auth.uid() = user_id);

create policy "Users can insert own todo state"
  on todo_state for insert
  with check (auth.uid() = user_id);

create policy "Users can update own todo state"
  on todo_state for update
  using (auth.uid() = user_id);

-- Task descriptions table (descriptions are stored here instead of in todo_state.state_data)
create table if not exists task_descriptions (
  task_id text not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  body text not null default '',
  updated_at timestamptz not null default now(),
  primary key (task_id, user_id)
);

alter table task_descriptions enable row level security;

drop policy if exists "Users can read own task descriptions" on task_descriptions;
drop policy if exists "Users can insert own task descriptions" on task_descriptions;
drop policy if exists "Users can update own task descriptions" on task_descriptions;
drop policy if exists "Users can delete own task descriptions" on task_descriptions;

create policy "Users can read own task descriptions"
  on task_descriptions for select
  using (auth.uid() = user_id);

create policy "Users can insert own task descriptions"
  on task_descriptions for insert
  with check (auth.uid() = user_id);

create policy "Users can update own task descriptions"
  on task_descriptions for update
  using (auth.uid() = user_id);

create policy "Users can delete own task descriptions"
  on task_descriptions for delete
  using (auth.uid() = user_id);
