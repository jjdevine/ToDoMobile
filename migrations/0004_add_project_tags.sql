-- Adds project tags using a validated tag catalog.
--
-- `todo.tags` stores the valid per-user tag values.
-- `todo.project_tags` maps projects to those valid tag values.
--
-- Note: tags are normalized to lowercase by the app before writing rows.

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

grant select, insert, update, delete on todo.tags to anon, authenticated, service_role;
grant select, insert, update, delete on todo.project_tags to anon, authenticated, service_role;
