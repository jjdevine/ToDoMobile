-- Preserve task descriptions when active tasks are moved to the archive.

alter table todo.archived_tasks
  add column if not exists body text not null default '';