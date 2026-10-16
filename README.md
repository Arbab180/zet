# Digital ZET

A phone-first web app that replaced the paper cash sheet a group of restaurants
in Cyprus fill in at closing time. It is in daily use.

Every night each restaurant "closes the till" and writes a **ZET** (the
end-of-day report) on paper: the register's total, what was paid by card, by
delivery platform, by cheque, what was paid out in cash to suppliers, and the
cash actually counted. Someone photographed the sheet, the figures were
re-typed later, and mistakes surfaced days afterwards or not at all.

Now the manager fills in the same sheet on a phone. The arithmetic is done for
them, receipts are photographed in place, and the night is stored, reviewed
and exported straight to the accountant's ledger.

## What it does

- **Fills in like the paper.** Two sheet layouts (a single-till ledger and a
  per-shift sheet) cover every restaurant, configured as data rather than
  hard-coded screens. Card machines, delivery platforms and extra lines vary
  per restaurant.
- **Does the reconciliation.** Expected cash, counted cash and the shortage
  or surplus are worked out live and recomputed on the server.
- **Reads receipts.** A photo of a supplier receipt is uploaded to private
  storage, and Claude reads the amount and line items off it. The model is
  called from the server only; the key never reaches the browser.
- **Review and approval.** Each restaurant has its own login and sees only its
  own nights. An admin reviews, approves and corrects; every correction keeps
  the previous revision and needs a reason.
- **Exports to the accounting system.** An approved night becomes a balanced
  double-entry journal (debits = credits, including the cash over/short line)
  as an `.xlsx` the ledger software imports.
- **Signed on screen.** The sheet is signed with a finger, as the paper was.

## Engineering decisions worth a look

**Money is integer cents, everywhere.** `bigint` columns named `*_cents`,
formatted only at the edge. Never floats: a reconciliation off by one cent is
rejected by whoever signs it.

**Parsing Greek-format amounts is the hardest small problem here.** Cyprus
writes `1.234,56`, so in `1.234` the dot is a thousands separator. An early
prototype read it as €1,23, a whole day's takings recorded as one euro, and
passed every manual check because the sample sheets all used commas. The
parser and its test table live in [`src/lib/money.ts`](src/lib/money.ts) and
[`src/lib/money.test.ts`](src/lib/money.test.ts).

**The server never trusts a total from the browser.** Every total is
recomputed from the raw inputs ([`src/lib/compute.ts`](src/lib/compute.ts)),
and input is validated with Zod on every request. TypeScript types vanish at
runtime, so they are not treated as a security boundary.

**Authorisation is enforced by the database, not just the app.** Postgres
row-level security scopes every row to the restaurants a user belongs to, and
the app refuses to run if it connects as a role that could bypass it.
[`db/probe.sql`](db/probe.sql) attacks the schema (cross-restaurant reads and
writes, editing approved nights, forging a correction) and asserts that each
attempt is refused.

**Approved nights are immutable, corrections are audited.** The database
blocks writes to an approved report; a correction must bump the revision and
give a reason, and the previous version is archived.

**Business date is not created date.** A shift that closes at 01:30 belongs to
the previous trading day. There is exactly one report per
`(restaurant, business_date)`, enforced by a unique constraint.

**Phones first.** Tested down to 320px wide, with touch targets of at least
40px on anything with a coarse pointer, including tablets.

## Stack

- **Next.js** (App Router, server actions) · **React** · **TypeScript**
- **PostgreSQL** with row-level security, plain SQL migrations, `pg` driver
- **Zod** for validation at the boundary
- **Cloudflare R2** for receipt photos, private bucket and short-lived signed URLs
- **Claude API** for reading receipts
- **Vitest** for tests
- Hosted on **Firebase App Hosting** with **Neon** Postgres

Deliberately few dependencies: no ORM, no UI kit, no AI SDK (one `fetch`).

## Layout

```
src/lib/         pure logic: money, reconciliation, sheet config, export (unit-tested)
src/server/      server-only: auth, saving, approval, receipt scan, storage, xlsx
src/app/         pages and server actions
src/components/  the sheet forms, receipt items, signature pad
db/              migrations, seed, demo data, security probes
docs/            the build spec, deployment guide
```

## Running it locally

Needs Node 22 and PostgreSQL.

```bash
npm install
npm test                 # unit tests, no database needed
cp .env.example .env.local
npm run hash-password    # fill in ADMIN_PASSWORD_HASH and SESSION_SECRET
npm run db:setup         # creates the database, roles and schema
npm run db:demo          # optional: a month of demo nights
npm run dev
```

Receipt photos and scanning are optional; without R2 and an Anthropic key the
app says they are not set up and everything else works. See
[`docs/DEPLOY.md`](docs/DEPLOY.md) for hosting.

## How it was built

Built with [Claude Code](https://claude.com/claude-code) as a pair, following
a written spec ([`docs/SPEC.md`](docs/SPEC.md)) and standing rules
([`CLAUDE.md`](CLAUDE.md)), with an adversarial review after every change:
looking for what was assumed rather than reading it through.
