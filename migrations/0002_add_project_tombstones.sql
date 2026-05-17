-- Adds project-level tombstones so project deletions can be merged across devices.

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
