# Laverie Transfer

Transfer board for SoHo and East Village staff. The app shell, database migrations, a health check, and CI are in place. Domain tables for Cents orders, batches, handoffs, and staff are migrated. Sign-in and the transfer board come in later slices.

Next.js (App Router) and TypeScript serve the UI and API. Postgres is the database, via Drizzle and plain SQL migrations. Hosted databases are Neon. Vitest covers unit and database tests. Playwright covers the smoke path. GitHub Actions runs on every pull request.

## Local setup

Requirements: Node.js 22, pnpm 10, and Postgres 16.

```bash
pnpm install
cp .env.example .env.local
```

Set `DATABASE_URL` in `.env.local`. With Docker:

```bash
docker compose up -d
```

```bash
DATABASE_URL=postgresql://laverie:laverie@127.0.0.1:5432/laverie
```

That user and password exist only for local Docker and the CI Postgres container. They are not a Neon or production credential.

Apply the bootstrap migration, then start the app:

```bash
pnpm db:migrate
pnpm dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) for the health result, or [http://127.0.0.1:3000/api/health](http://127.0.0.1:3000/api/health) for the JSON API.

A healthy database looks like this:

```json
{
  "ok": true,
  "database": "up",
  "migrationVersion": {
    "id": 3,
    "hash": "<sha256 of drizzle/0002_terminal_order_membership.sql>",
    "createdAt": "<journal timestamp of that migration>"
  }
}
```

`ok` is true only when `SELECT 1` succeeds. `migrationVersion` is the latest row in `drizzle.__drizzle_migrations`. It is null when that table is not there yet. A database the app cannot reach returns HTTP 503 and `"database": "down"`.

## Cents webhook intake

Cents posts order events to `/api/cents/webhook`. Configure one custom header for the business and map the two locations to their Cents store IDs. For the local fixture, use these test values in `.env.local`.

```dotenv
CENTS_WEBHOOK_HEADER_NAME=X-Cents-Test
CENTS_WEBHOOK_HEADER_SECRET=fixture-only
CENTS_STORE_ALLOWLIST='{"soho":101,"east_village":102}'
```

With the local server running, send the fixture and inspect the most recent 50 redacted events.

```bash
pnpm cents:send fixtures/order-created.json
pnpm db:show raw-events
```

The sender targets loopback on port 3000 or the local `PORT` setting. The webhook returns 200 after the insert commits. Each delivery gets a raw row. Repeated fingerprints point to the first receipt. S3 applies newer webhook data to the store-scoped order snapshot. On a timestamp tie a terminal status wins over an open one. A later attempt to reopen a terminal order is recorded for review.

Use `cents_status_allows_transfer(status)` for the Cents part of an eligibility query. Postgres also checks the status when adding a batch membership. Existing memberships keep their transfer phase if Cents completes or cancels their order.

Unknown stores are recorded for review. Unrelated event types are acknowledged and skipped.

## Checks

```bash
pnpm db:migrate
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm test` is Vitest and talks to the Postgres database in `DATABASE_URL`. `pnpm test:e2e` starts `pnpm start`, so build first. CI does this against a Postgres service container and needs no repository secrets.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Next.js dev server |
| `pnpm db:migrate` | Apply Drizzle SQL migrations |
| `pnpm db:generate` | Generate a migration from `db/schema.ts` |
| `pnpm check:invariants` | Assert the transfer rules that the database can see |
| `pnpm typecheck` | Generate Next types, then `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest |
| `pnpm test:e2e` | Playwright smoke test |
| `pnpm build` / `pnpm start` | Production build and server |

## Environments

Preview deployments use their own database and test-only secrets. Do not copy production order data or production credentials into a preview. Do not point the Cents webhook at a preview URL. Production webhook secrets stay in the production environment.

CI does not use Neon. The workflow starts `postgres:16` and sets `DATABASE_URL` to that container.

`vercel.json` runs `pnpm db:migrate` before `pnpm build`. On Vercel, set `DATABASE_URL` to the Neon pooled connection string for that environment, including `sslmode=require`. The app uses `pg` with standard Postgres, so a later move off Neon is a `pg_dump` and a config change.

Names and purposes of every variable are in `.env.example`. Values stay out of git.

## What Daniel still has to do

This slice does not link the GitHub repo to Vercel or provision Neon. Those need Daniel's accounts.

1. Create a Neon project for this app. Keep production data on the production branch only.
2. Give each Vercel preview its own database: the Neon–Vercel integration (a branch per preview) or a separate non-production database. Do not paste the production connection string into Preview.
3. Import `Dansong00/laverie-transfer` into Vercel. Framework Next.js, package manager pnpm, Node.js 22. The repo already sets the install and build commands.
4. Add the variables in `.env.example` for Preview and Production. Preview values are test-only. In particular, Preview must not reuse production `DATABASE_URL`, `SESSION_SECRET`, `CENTS_WEBHOOK_HEADER_SECRET`, `BOOTSTRAP_ADMIN_PHONE`, or `SMS_PROVIDER_API_KEY`.
5. Deploy a preview. Open `/` and `/api/health`. Expect `ok: true`, `database: "up"`, and migration id `3`.
6. Leave the Cents webhook unset until go-live, and never aim it at a preview.

Staff sign-in and the transfer board are later slices.
