# Laverie Transfer

Transfer board for SoHo and East Village staff. The app shell, database migrations, a health check, and CI are in place. Domain tables for Cents orders, batches, handoffs, and staff are migrated. Staff can sign in by text. The shared board tracks batches through receipt, processing and readiness for return.

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

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) for staff sign-in, or [http://127.0.0.1:3000/api/health](http://127.0.0.1:3000/api/health) for the JSON API.

A healthy database looks like this:

```json
{
  "ok": true,
  "database": "up",
  "migrationVersion": {
    "id": 6,
    "hash": "<sha256 of drizzle/0005_planned_batch_changes.sql>",
    "createdAt": "<journal timestamp of that migration>"
  }
}
```

`ok` is true only when `SELECT 1` succeeds. `migrationVersion` is the latest row in `drizzle.__drizzle_migrations`. It is null when that table is not there yet. A database the app cannot reach returns HTTP 503 and `"database": "down"`.

## Staff sign-in

Set `SESSION_SECRET` to a random secret of at least 32 bytes. Set `APP_DOMAIN` to the app hostname, `SMS_PROVIDER_API_KEY` to a Telnyx messaging API key, and `SMS_FROM` to its SMS-enabled sending number. Use environment-specific test credentials and numbers on preview.

For first-time setup, set `BOOTSTRAP_ADMIN_PHONE` to the first admin’s E.164 number and run `pnpm staff:bootstrap` against the intended database. The command refuses if any admin already exists, including a disabled one.

At `/`, enter a mobile number and the six-digit code sent by text. US numbers also accept local formatting. Texts go only to active staff. Codes expire after ten minutes. Staff can request another after 30 seconds, up to five sends per rolling hour. Five incorrect guesses lock that code. A new send replaces the previous code.

`GET /api/session` returns the signed-in staff member’s ID, name, and current role, or HTTP 401. A secure HTTP-only cookie identifies a server-side session. Sessions expire after 30 days or seven idle days. Sign-out revokes the session. Use HTTPS for SMS autofill on supported mobile browsers.

## Profiles and staff administration

After sign-in, the profile shows the staff member’s name and current role. Admins also see their registered number and a **Staff admin** link. In the directory, admins can register a number, change someone’s role, or disable their access. Disabling a staff member revokes all of their sessions immediately.

Directory changes and their audit records commit together. The server rejects a change that would remove the last active admin, including concurrent changes. Retrying a confirmed change with the same operation ID returns the saved result.

## Transfer board

Open **Transfer board** from the staff profile. Planned batches appear at their origin. Arriving, Received, Processing, and Ready for return appear at the destination. Both stores see Returning and Recently returned. Open a batch to see its retained orders and handoff history. The board refreshes every 45 seconds while visible and when reopened or focused.

**Board sections** saves the selected sections for the signed-in staff member across stores and devices. All seven sections start visible.

At the destination, use **Mark received** on an arriving batch. Open the batch to start processing received orders and mark processing orders ready, individually or together. A bulk change advances the batch version once and records one handoff per selected order. The destination must record receipt before confirming corrected contents, even when no orders remain.

## Planned batches

Open **Eligible orders** on the staff profile, select the origin store, and choose orders to create a planned batch. Open a batch from **Planned batches** to add orders, remove an order with a note, or cancel the batch. Cancellation keeps its history and releases orders that are still eligible for transfer.

Choose **Mark sent** when the batch leaves. If Cents has closed an order since planning, the app lists its number so staff can remove it with a note before sending. If the phone loses the confirmation, reopening the orders page for that store checks the original departure. **Already saved** confirms that it was recorded.

### Sent-batch contents

On **Eligible orders**, choose the destination store and open a batch under **Sent to**. An admin can record orders that did not travel and give a reason for each. At the receiving store, staff check the remaining orders and choose **Confirm contents** after receipt. Each correction requires a fresh confirmation before return. The history keeps earlier confirmations with their staff member, time and order set.

In the operations ledger, forward transitions use their action name (for example, `send` or `sendReturn`) as `operations.kind`. Other commands use their command name, such as `correctSentMembership` or `confirmContents`.

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

Use `cents_status_allows_transfer(status)` for the Cents part of an eligibility query. Postgres uses the same rule when adding a batch membership. Open statuses are `SUBMITTED`, `IN_PROGRESS`, and `READY_FOR_PICKUP`. The check ignores case and surrounding spaces. All other statuses are ineligible. Existing memberships keep their transfer phase if Cents completes or cancels their order.

Unknown stores are recorded for review. Unrelated event types are acknowledged and skipped.

## Import a Cents Orders report

Run the import against the same database and `CENTS_STORE_ALLOWLIST` used by webhook intake. The provisional CSV format must include `Order Code`, `Location`, and `Status`. The first stored ticket spelling is preserved. Both writers trim surrounding whitespace and match digit-only codes regardless of zero padding within the same store. Alphanumeric codes retain their case and internal zeros. Location can be a configured Cents store ID or a store name such as `SoHo`, `Laverie SoHo`, or `East Village`.

```bash
pnpm cents:backfill --dry-run /path/to/orders.csv
pnpm cents:backfill /path/to/orders.csv
```

The optional `Due Date` accepts ISO dates, US month/day/year dates, and timestamps. Both writers store date-only values at midnight UTC. Unzoned times use America/New_York. Optional first and last name columns contribute only a first name and last initial. The importer discards other customer fields and leaves the personal-detergent flag unset pending confirmation of the modifier name.

At go-live, enable and verify the webhook, then generate a fresh export, dry-run it, and import it promptly. Verify real headers, statuses, order codes and date semantics using the [first-import runbook](docs/cents-orders-go-live.md).

Each row commits independently. The command reports inserted and already-present counts. If it stops on an invalid record, correct the file and run it again. An existing order keeps its snapshot. A newer webhook can supersede a backfilled order, and a backfilled terminal order stays ineligible if a later webhook tries to reopen it.

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

`pnpm test` runs Vitest against Postgres using `DATABASE_URL`. The Cents webhook, Cents backfill, staff auth, and staff directory suites each create, migrate, and drop a disposable database. Use a local or CI test role with `CREATEDB`. `pnpm test:e2e` starts `pnpm start`, so build first. CI does this against a Postgres service container and needs no repository secrets.

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
5. Deploy a preview. Open `/` and `/api/health`. Expect the sign-in form at `/` and `ok: true` with the hash of `0005_planned_batch_changes.sql` at `/api/health`.
6. Leave the Cents webhook unset until go-live, and never aim it at a preview.
