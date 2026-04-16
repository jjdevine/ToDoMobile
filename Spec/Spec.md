The app is a to do list application, designed for web and mobile usage. In the same style as the flashcards application it should be html and javascript based, with supabase persistence and authenticated login. It will be deployed in github pages.

The app has one or more projects. When you enter a project, you will be presented with a list of the next 7 days, with metadata visible of how many tasks are required that day, how many are complete, and how many are incomplete. The list item for today should be highlighted in a more prominent colour.

When you select one of the days, the tasks for that days are shown.

Tasks for each project are automatically generation by configuration files. The name of each configuration file maps to the project name. Eg "Daily Tasks.txt" becomes the "Daily Tasks" project.

Each time the app is loaded, the project checks the configuration file and adds any tasks that needed to be added for days now in scope. For example if the user opens the app on monday, the app should process any new tasks required until the end of the week. A button to manually request this process should also be provided.

The configuration file is in the format of the example "Daily Tasks.txt" attached. The logic to convert this format into tasks is demonstrated in the provided code ToDoListGenerator.java

Tasks can be manually added into the application. They should have a mandatory name, and an optional description. Tasks can have a due date, but can also have no due date, in which case they appear in a "No Due Date" section of a project rather than within a specific date.

Tasks can be marked as complete, at which point they are removed from the list, and stored in an archive. The user should be prompted to confirm before a task is marked as complete.

Tasks can be deferred to a future date. When deferring a task you are asked for a day within the next 7 days you want to defer it to.

Tasks that are from previous days but incomplete should be shown in an "overdue" list within the project

A project should give an option to download all active tasks. Archives can also be downloaded.

Archives can be deleted. Users should be prompted to confirm before deletion.

Changes to the list are persisted 2 seconds after they are made.

The application should work offline using a service worker approach.