-- Atomic server-side workflows for the server-authoritative client.

create or replace function todo.complete_task(
  p_project_id text,
  p_task_id text
)
returns void
language plpgsql
security invoker
set search_path = todo, public
as $$
declare
  affected_rows integer;
begin
  insert into todo.archived_tasks (
    user_id,
    project_id,
    id,
    name,
    due_date,
    source,
    generated_key,
    pinned,
    end_of_day,
    body,
    completed_at,
    created_at,
    updated_at
  )
  select
    user_id,
    project_id,
    id,
    name,
    due_date,
    source,
    generated_key,
    pinned,
    end_of_day,
    body,
    now(),
    created_at,
    now()
  from todo.tasks
  where user_id = auth.uid()
    and project_id = p_project_id
    and id = p_task_id
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
  where user_id = auth.uid()
    and project_id = p_project_id
    and id = p_task_id;
end;
$$;

create or replace function todo.complete_tasks(
  p_project_id text,
  p_task_ids text[]
)
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
    select 1
    from todo.projects
    where user_id = auth.uid()
      and id = p_project_id
      and inactive = false
  ) then
    raise exception 'Active project not found';
  end if;

  for candidate in
    select *
    from jsonb_to_recordset(coalesce(p_candidates, '[]'::jsonb)) as item(
      id text,
      name text,
      body text,
      due_date text,
      generated_key text
    )
  loop
    insert into todo.generated_occurrences (
      user_id,
      project_id,
      occurrence_key,
      task_id,
      due_date,
      task_name,
      created_at
    ) values (
      auth.uid(),
      p_project_id,
      candidate.generated_key,
      candidate.id,
      candidate.due_date,
      candidate.name,
      now()
    )
    on conflict (user_id, project_id, occurrence_key) do nothing;

    get diagnostics occurrence_inserted = row_count;
    if occurrence_inserted = 1 then
      insert into todo.tasks (
        user_id,
        project_id,
        id,
        name,
        due_date,
        source,
        generated_key,
        pinned,
        end_of_day,
        body,
        created_at,
        updated_at
      ) values (
        auth.uid(),
        p_project_id,
        candidate.id,
        candidate.name,
        candidate.due_date,
        'generated',
        candidate.generated_key,
        false,
        false,
        coalesce(candidate.body, ''),
        now(),
        now()
      );
      created_count := created_count + 1;
    end if;
  end loop;

  update todo.projects
  set last_generated_through = p_generated_through
  where user_id = auth.uid()
    and id = p_project_id;

  return created_count;
end;
$$;

revoke all on function todo.complete_task(text, text) from public;
revoke all on function todo.complete_tasks(text, text[]) from public;
revoke all on function todo.generate_recurring_tasks(text, text, jsonb) from public;
grant execute on function todo.complete_task(text, text) to authenticated;
grant execute on function todo.complete_tasks(text, text[]) to authenticated;
grant execute on function todo.generate_recurring_tasks(text, text, jsonb) to authenticated;