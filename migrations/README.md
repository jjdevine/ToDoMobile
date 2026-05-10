# SQL Migrations

Store one-way database migration scripts in this folder.

## Naming convention

Use zero-padded numeric prefixes so alphabetical order matches execution order:

- `0001_description.sql`
- `0002_description.sql`
- `0003_description.sql`

Rules:

- Prefix must be 4 digits.
- Use lowercase snake_case after the prefix.
- Never rename an applied migration.
- Always add new migrations with the next number.
