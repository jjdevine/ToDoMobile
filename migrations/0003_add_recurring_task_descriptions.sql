-- Migration: Add recurring_task_descriptions table
--
-- This table provides project-scoped default descriptions for recurring tasks.
-- For each project, a user can configure a mapping from a recurring task name
-- (exact match) to a default description text (supports multiline).
-- When the recurring-task generator creates a new task whose name matches an
-- entry in this table, the task is created with that description pre-filled.

create table if not exists todo.recurring_task_descriptions (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  project_id  text        not null,
  task_name   text        not null,
  description text        not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, project_id, task_name),
  foreign key (user_id, project_id) references todo.projects(user_id, id) on delete cascade
);

create index if not exists idx_recurring_task_descriptions_user_project
  on todo.recurring_task_descriptions (user_id, project_id);

-- Keep updated_at current on every update.
create or replace function todo.set_recurring_task_descriptions_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_recurring_task_descriptions_updated_at on todo.recurring_task_descriptions;

create trigger trg_recurring_task_descriptions_updated_at
before update on todo.recurring_task_descriptions
for each row execute function todo.set_recurring_task_descriptions_updated_at();

alter table todo.recurring_task_descriptions enable row level security;

drop policy if exists "Users can read own recurring task descriptions" on todo.recurring_task_descriptions;
drop policy if exists "Users can insert own recurring task descriptions" on todo.recurring_task_descriptions;
drop policy if exists "Users can update own recurring task descriptions" on todo.recurring_task_descriptions;
drop policy if exists "Users can delete own recurring task descriptions" on todo.recurring_task_descriptions;

create policy "Users can read own recurring task descriptions"
  on todo.recurring_task_descriptions for select
  using (auth.uid() = user_id);

create policy "Users can insert own recurring task descriptions"
  on todo.recurring_task_descriptions for insert
  with check (auth.uid() = user_id);

create policy "Users can update own recurring task descriptions"
  on todo.recurring_task_descriptions for update
  using (auth.uid() = user_id);

create policy "Users can delete own recurring task descriptions"
  on todo.recurring_task_descriptions for delete
  using (auth.uid() = user_id);

grant select, insert, update, delete on todo.recurring_task_descriptions to anon, authenticated, service_role;
