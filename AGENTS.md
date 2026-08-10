# Outbox — working notes

Self-hostable Resend clone. Bun workspace, Atlas, PostgreSQL. Read this before
changing anything.

## Conventions

Inherited from Atlas — see `../atlas/SOUL.md` if it is checked out beside this repo.

- Filenames are lowercase, no dashes or underscores. Hierarchy comes from
  directories: `packages/<name>/<feature>/index.ts`.
- Functional only. No `class`. Transforms return new objects.
- Bun APIs over `node:*` when both exist (`Bun.serve`, `Bun.sql`, `Bun.connect`,
  `Bun.password`). `node:crypto` and `node:dns/promises` have no Bun equivalent
  and are used directly.
- Imports come from `@wess/atlas/<pkg>` — Atlas is a git dependency, not a
  workspace member. Its packages cross-import by relative path, so consuming it
  from `node_modules` works.

## Things that will bite you

**`from` and `to` are reserved words in Postgres.** `@atlas/db` emits bare,
unquoted identifiers, so those columns are named `from_address` and
`to_addresses` (also `reference_ids` for `references`). The serialisers in
`packages/core/serialize` map them back to the API's `from` / `to`. Only these
three names are unsafe among the ones this schema uses — `text`, `key`, `value`,
`type`, `status`, `name`, and `position` are all fine.

**`@atlas/db` has no `RETURNING *`.** `returning()` is typed over the schema's
column keys and emits nothing when given none. Use
`.returning(...allColumns(schema))` from `@outbox/core/db`.

**`WhereBuilder` has no `.and()`.** Return an array of predicates from the
callback and they are ANDed: `where(q => [q("a").equals(1), q("b").equals(2)])`.
`.or()` and `.raw()` do exist.

**Bun's Postgres driver does not bind JS arrays to Postgres arrays.**
`= ANY($1::uuid[])` fails. Bind the array itself and expand it with
`jsonb_array_elements_text` — `anyOf()` and `jsonArray()` in
`@outbox/core/pagination` do this. Do not pre-stringify the array; that produces
a jsonb scalar and Postgres refuses to expand it.

**An unreferenced query parameter has no inferable type.** Postgres raises
`42P18` if you bind a value the SQL never mentions. Push parameters only when the
branch that uses them runs — see the timezone handling in
`packages/api/routes/metrics`.

**Cursor pagination must compare inside SQL.** A `created_at` round-tripped
through a JS `Date` loses Postgres microseconds, which leaves the cursor row
inside its own range. `paginate()` compares `(created_at, id)` against a
subquery instead.

**Header values must be sanitised.** A bare CR or LF in a subject, display name,
or custom header injects a header. `stripControls` in `packages/core/mime` runs
on every value and header name. There are regression tests for this — keep them.

## Route ordering

`@wess/atlas/server`'s router matches in registration order and does not rank
static segments above dynamic ones. `/emails/metrics` must be registered before
`/emails/:id` or it will never match. `packages/api/index.ts` documents the
intended order; adding a static path under an existing `:id` prefix means putting
it earlier in the array.

## Error handling

Route handlers are wrapped by `wrap()` in `packages/api/pipes`, which renders
thrown `HttpError`s into Resend's `{ statusCode, name, message }` envelope and
writes the API log. The router's own catch never fires. Postgres constraint
violations are translated there too — a unique violation is a 409, not a 500.

## Auth

One `Principal` covers both callers: an API key (Bearer) or a dashboard session
cookie. That is why the dashboard reaches the same endpoints as the public API
instead of needing a parallel set. `authedFull` requires full access;
`authed` also accepts `sending_access` keys and is used only on the send routes.

## Instance ownership

The first account created owns the instance (`users.is_owner`). The claim is made
inside the INSERT with `NOT EXISTS (SELECT 1 FROM users)` and guarded by the
partial unique index `users_single_owner_idx`. Signup catches a `23505` on *that
constraint specifically* and retries with `is_owner = false`, so the loser of a
concurrent race still gets an account. Do not turn that catch into a blanket
`23505` handler — it would swallow the duplicate-email violation.

## Adding an endpoint

1. Schema in `packages/schema/<area>/index.ts`, plus SQL in a new migration
   folder under `migrations/`. Hand-write the SQL — `migrate.diff` emits no
   indexes, foreign keys, or unique constraints.
2. Confirm the schema matches: `bun run migrate && bun run bin/outbox.ts migrate diff`
   should report "schema in sync".
3. Serialiser in `packages/core/serialize`, so the response shape lives in one place.
4. Route in `packages/api/routes/<area>`, registered in `packages/api/index.ts`.
5. A case in `packages/api/test/smoke.ts`.

## Tests

- `bun test` — unit tests, no server or database needed.
- `packages/api/test/smoke.ts` — API contract, needs a running server and an API key.
- `packages/worker/test/e2e.ts` — full pipeline including a real webhook receiver.

Both integration suites back off on 429 because the rate limiter is real.

## Local setup

```sh
bun install
bun run db:up && bun run migrate && bun run seed
bun run dev
```

Postgres runs in Docker on port 55432 to stay clear of a system install.
