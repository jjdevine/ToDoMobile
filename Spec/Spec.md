# Task Planner Spec

This document describes the current implemented functionality of the Task Planner application.

## Platform and deployment

The app is a web-based task planner designed for desktop and mobile use. It is built with HTML, CSS, and JavaScript and is suitable for deployment to GitHub Pages.

The app supports Supabase authentication and cloud persistence when Supabase is configured. It can also be used in local-only mode, either because Supabase keys are not present or because the user chooses to continue without signing in.

The application supports offline use through a service worker.

## Project sources

The app supports two kinds of projects:

1. **Configured projects** — projects that have a recurring task configuration, supplied by the user via the in-app configuration screen.
2. **Manual projects** — projects that have no recurring configuration; they contain only user-created tasks.

All projects are created in the UI. There are no longer any `.txt` configuration files in the repository.

### Adding a recurring configuration

From the project screen, any project can be given a recurring configuration by clicking the **Configure** button. The configuration modal allows the user to either:

- Paste configuration text directly into a textarea, or
- Upload a `.txt` file in the same format.

The configuration text is stored in the Supabase `project_configs` table (when signed in) and cached in `localStorage` for offline use. Project configurations are never stored in the repository.

The configuration format is the same as the previous `Projects/*.txt` format:

- Each line is either a comment (`# ...`) or a task rule.
- Task rules follow the pattern: `task name-weekly-monday,friday`, `task name-monthly-1`, or `task name-annual-MM-DD`.

Once a configuration is saved, the project immediately generates any recurring tasks for the current 7-day window.

The configuration can be updated or cleared at any time from the Configure button on the project screen.

Manual projects are task containers for user-created tasks only. They do not have recurring generation rules, and refresh actions for those projects are disabled until a configuration is added.

## Home screen

The home screen shows all projects as cards.

Each project card shows:

- The project name
- Whether it is a recurring project or a manual project
- Counts for active tasks, due today, overdue tasks, tasks with no due date, and archived tasks
- Generation status for recurring projects, or a manual-project label for manual projects
- A `☆ Set default` / `★ Default` button to configure a default project

The home screen also provides:

- A `Generate tasks now` action to run recurring task generation for all configured projects
- A `New Project` form for creating projects (which can then be given a recurring configuration via the project screen)

If there are no projects, the app explains that the user can create a project using the `Create project` button.

## Default project

Any project can be configured as the default project. When a default project is set, opening the app automatically navigates to the day view for today within that project, skipping the home screen.

Each project card on the home screen has a `☆ Set default` button. Clicking it marks that project as the default. The button changes to `★ Default` for the active default project. Clicking `★ Default` clears the default so the app opens on the home screen as usual.

The default project setting is stored as part of the app state and syncs across devices when Supabase sync is enabled.

## Recurring project generation

Projects with a recurring configuration generate tasks automatically. The configuration is provided in-app via the Configure button on the project screen (see **Project sources** above).

Supported recurring rules are:

- Weekly rules, using named weekdays
- Monthly rules, using day numbers
- Annual rules, using a specific day and month (format: `MM-DD`, e.g. `01-15` for January 15th)

On app load, generated projects create any missing recurring tasks from today through the end of the current 7-day window.

The user can also manually trigger recurring generation:

- For all generated projects from the home screen
- For the current generated project from the project screen or day/task-list screen

Generated tasks are tagged as recurring. User-created tasks are tagged as manual.

## Project screen

When a project is opened, the project screen acts as a navigation and summary view rather than a task-list view.

The project screen contains:

- An `Add Task` button
- A **Configure** button (opens the configuration modal for adding or editing the recurring configuration)
- A **Refresh tasks** button for configured projects
- An `Overdue` entry directly below the refresh button
- A `No Due Date` entry below the `Overdue` entry
- A `Next 7 Days` list
- Summary cards for `Active`, `Due Today`, `Overdue`, and `No Due Date`
- An `Add Task` form

Today is highlighted within the 7-day list.

The `Overdue` and `No Due Date` entries appear above the `Next 7 Days` list. Each opens its own dedicated task-list view. Task items themselves are not shown directly on the project screen.

Selecting one of the day entries opens the task-list view for that specific day.

The `Add Task` form on the project screen allows the user to create a manual task with:

- A required name
- An optional description
- An optional due date

Manual tasks may also have no due date.

## Task-list screen

The task-list screen is used for both:

- A selected day
- The overdue view
- The no-due-date view

When a normal day is opened, the task-list screen shows:

- A section for the selected day
- A `Later` section for tasks due after the current 7-day window, when applicable

When the overdue view is opened, the task-list screen shows overdue tasks only.

When the no-due-date view is opened, the task-list screen shows tasks with no due date only.

The task-list screen also provides:

- A refresh button for recurring projects
- A `Download active` action for exporting all active tasks in the project
- A `View archive` action to open the archive screen
- An `Add Task` form

## Task behavior

Tasks can be created automatically from recurring configuration, or manually by the user.

Each active task can show:

- Its due date, or a `no due date` marker
- Whether it is recurring or manual

Active tasks support the following actions:

- `Complete`
- `Defer` or `Schedule`
- `Edit`
- `Delete`

Completing a task prompts for confirmation, removes it from the active list, and moves it into the archive.

Deferring a task prompts the user to choose a new date within the remaining visible day range, from tomorrow through the end of the current 7-day window.

Editing a task allows the user to update its name, description, and due date, including clearing the due date.

Deleting an active task is a permanent delete and does not move the task into the archive.

## Overdue and no-date behavior

Tasks whose due dates are before today are treated as overdue.

Overdue tasks are accessed from the dedicated `Overdue` entry on the project screen and shown in their own task-list view.

Tasks with no due date are not attached to a specific day. They are accessed from the dedicated `No Due Date` entry on the project screen and shown in their own task-list view.

## Archive behavior

Completed tasks are stored in a per-project archive.

The archive is shown on its own screen and includes:

- A list of completed tasks
- A `Download archive` action
- A `Delete archive` action for removing the entire archive

Users are prompted before deleting the full archive.

Archived tasks also support individual deletion.

## Editing, persistence, and sync

Changes are persisted 2 seconds after they are made.

The app stores state locally and, when the user is signed in, also syncs state to Supabase.

When cloud sync is enabled, the app supports:

- Sign up
- Sign in
- Sign out
- Manual sync
- Automatic merge of local and remote state

If the user is not signed in, the app continues in local-only mode.
