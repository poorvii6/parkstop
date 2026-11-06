# Migrations

Schema changes are applied by `prisma migrate deploy`, which runs from `npm start`
on every Railway deploy. It applies any migration the database has not seen and
exits quietly when there are none. It never asks a question, which is the point:
`prisma db push` does, and on 6 November 2026 it refused to add a unique
constraint without `--accept-data-loss`, failed, and because start is
`<db step> && node src/server.js`, the server never started. The backend was
down until the index was created by hand.

## Changing the schema

1. Edit `prisma/schema.prisma`.
2. `npx prisma migrate dev --name short_description_of_change`
   Writes a new folder under `prisma/migrations/` and applies it to your local
   database. Read the generated SQL before committing it.
3. Commit the schema change AND the migration folder together.
4. Push. Railway runs `migrate deploy` and applies it.

Never edit a migration that has already been deployed. Write a new one.

## 0_init

The baseline. The database existed long before migrations did, built up by
repeated `prisma db push`, so `0_init` describes the schema as it already stood
and was marked applied with `prisma migrate resolve --applied 0_init` rather
than being run. Running it against the live database would fail, because every
table in it is already there.
