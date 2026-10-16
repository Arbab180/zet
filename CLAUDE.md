# Digital ZET — project instructions

Replaces the paper cash sheet that four restaurants under **C.A. China Spice
Restaurants LTD** fill in at closing time. A manager fills the same sheet on a
phone, the arithmetic is done for them, and the record is stored. It will feed
the AI invoicing project later: receipt photo → amount → supplier invoice.

The full spec is in `docs/SPEC.md`. Read it before designing anything.

## How we work

**build → review → fix → test.** Every change. The review is adversarial —
hunting for what was assumed, not a read-through. The worst bug in the
prototype (`1.234` parsed as €1,23) passed every manual check because all four
sample sheets happened to use commas.

Never mark work done while tests fail.

## Rules that are not negotiable

1. **Money is integer cents.** `bigint` in the database, columns named
   `*_cents`, formatted only at the edge. Never floats.
2. **The server recomputes every total** from raw inputs. A total posted by
   the browser is never stored. Anyone can open devtools.
3. **Authorise per restaurant on every request.** Not once at login.
4. **TypeScript is not a security boundary.** Types vanish at runtime.
   Validate at the boundary with Zod, on the server, every request.
5. **Business date ≠ created date.** A shift closing at 01:30 belongs to the
   previous trading day. One report per `(restaurant, business_date)`,
   enforced by a unique constraint.
6. **Identify things by what they are, not by what they are called.** The
   prototype detected money fields with `/^f_/` and so stripped the letters
   out of the *name* field. A naming convention is not a type.

## Don't

- Don't port the prototype's DOM code. `docs/SPEC.md` and `src/lib/` are the
  inheritance; the UI is written fresh.
- Don't put an upper limit on amounts. A big number is usually a real day.
- Don't use `alert` / `confirm` / `prompt`. They fail silently in embedded
  contexts. Ask in-page.
- Don't set layout-critical CSS inline — inline styles outrank media queries
  and that silently broke the entire phone layout once.

## Stack

Next.js App Router · TypeScript · Postgres. Vitest for unit tests, Playwright
for the flows. Keep dependencies few.

## Testing

`src/lib/money.test.ts` and `src/lib/compute.test.ts` are already written and
green. They encode real sheets. **If one fails, the code is wrong — not the
fixture.**

Phones first: test at 320px, not just 390px. Touch targets ≥ 40px, keyed on
`(max-width:700px), (pointer:coarse)` — a tablet is a wide screen with fat
fingers.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
