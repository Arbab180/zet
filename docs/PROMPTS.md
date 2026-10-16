# Build plan — prompts to paste into Claude Code, in order

One step per prompt. Wait for each to be green before the next. If a step
sprawls, stop it and split it — a prompt that touches twenty files is a prompt
you cannot review.

Every step ends the same way: **build → review → fix → test.**

---

## 0. Orient (run once)

```
Read CLAUDE.md and docs/SPEC.md. Then run `npm install && npm test` and tell me
what passes. Don't change any code yet — just confirm the fixtures are green
and summarise what src/lib already gives us.
```

Expect: 30-odd assertions green across money and compute. If they fail, the
toolchain is wrong, not the code.

---

## 1. Schema

```
From docs/SPEC.md §6 and claude/zet-daily-report-schema.md, write the Postgres
schema and the first migration. All money columns bigint named *_cents. Unique
constraint on (restaurant_id, business_date). Include the revisions table —
approved reports are immutable, corrections are new revisions.

Do not write any UI. Show me the migration and explain the two decisions you
were least sure about.
```

---

## 2. Auth and authorisation — before any UI

```
Add authentication and per-restaurant authorisation. Requirements from
CLAUDE.md rules 2-4:
- every request re-checks that this user may write to this restaurant
- totals are recomputed server-side from raw inputs; a posted total is ignored
- Zod validation at the boundary

Write the authorisation check as a single function with unit tests covering:
allowed, wrong restaurant, no session, expired session, read-only role.
```

Then review it yourself before accepting. This is the part most likely to look
right and be wrong.

---

## 3. Server actions for a report

```
Write the server action that saves a daily report. It takes raw inputs only —
never a computed total — recomputes with src/lib/compute.ts, and persists.
Include the validation rules from docs/SPEC.md §5. Unit-test it with the three
ledger fixtures and the China Spice fixture from src/lib/compute.test.ts.
```

---

## 4. The ledger form (ΑΝΑΜΜΑ + both Chopsticks)

```
Build the ledger form as a React client component driven by the config in
src/lib/forms.ts — one component that renders any ledger form, not three.

It must look like the paper: black print on white, entries in ballpoint blue
#1D3E9C, hairline rules, the form's own Greek labels, the printed − and =
signs, the α)…ε) order slots in the left column, both ΕΠΙΤΑΓΕΣ notes verbatim,
14 expense rows.

Phone first — test at 320px. Touch targets ≥ 40px.
```

---

## 5. The shifts form (CHINA SPICE)

```
Build the CHINA SPICE form: ΤΑΜΕΙΟ block, three shift columns, the payment
rows with the vertical VISA VIS bracket over JCC and GAP, per-column invoice
lines carrying supplier and invoice number, and the TOTAL row.

Same config-driven approach. Verify against the fixture: expected 648,42,
accounted 543,40, difference 105,02.
```

---

## 6. Drafts, archive, revisions

```
Add: a debounced local draft that offers to restore on load (never restores
silently); an archive filtered to the restaurants this user may see; and
revision history so an approved report is corrected by a new revision rather
than an edit.
```

---

## 7. Receipt scanning

```
Implement POST /api/scan per docs/SPEC.md §9: multipart field `file`, returns
{total, supplier, invoiceNumber, date, confidence}. Call the Anthropic API
from the server — the key never reaches the browser.

A scanned amount is a suggestion, not a record: it arrives editable and
visibly provisional.
```

---

## 8. End-to-end

```
Write Playwright tests covering: fill and save a sheet on each of the four
forms; a slot mismatch blocking the save; an itemised total disagreeing with
its row; restoring a draft; reopening from the archive; a user from one
restaurant being refused another's report.

Run them at 390px and 1280px.
```

---

## Prompts worth reusing

Review:
```
Review what you just wrote as a senior engineer would. Look for bugs, wrong
assumptions, missing error paths and anything that would corrupt a saved
financial record. Be specific about severity. Do not fix anything yet.
```

When something looks wrong:
```
Write a failing test that reproduces this before you fix it.
```

When a step sprawls:
```
Stop. Revert the parts not needed for the one thing I asked for, and do only
that.
```
