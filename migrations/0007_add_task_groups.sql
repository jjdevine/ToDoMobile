alter table todo.tasks
  add column if not exists group_id text;

alter table todo.archived_tasks
  add column if not exists group_id text;

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
    end_of_day, group_id, body, completed_at, created_at, updated_at
  )
  select
    user_id, project_id, id, name, due_date, source, generated_key, pinned,
    end_of_day, group_id, body, now(), created_at, now()
  from todo.tasks
  where user_id = auth.uid() and project_id = p_project_id and id = p_task_id
  on conflict (user_id, project_id, id) do update
  set name = excluded.name,
      due_date = excluded.due_date,
      source = excluded.source,
      generated_key = excluded.generated_key,
      pinned = excluded.pinned,
      end_of_day = excluded.end_of_day,
      group_id = excluded.group_id,
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
