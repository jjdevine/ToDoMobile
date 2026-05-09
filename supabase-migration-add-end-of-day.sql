-- Migration: add end_of_day column to tasks and archived_tasks
-- Run this in your Supabase SQL editor against an existing database that was
-- set up with supabase-normalized-schema.sql BEFORE this column was added.
--
-- How to run:
--   1. Open your Supabase project → SQL Editor.
--   2. Paste the contents of this file and click Run.
--   3. Confirm the new column appears under Table Editor for both tables.

alter table todo.tasks
  add column if not exists end_of_day boolean not null default false;

alter table todo.archived_tasks
  add column if not exists end_of_day boolean not null default false;
