# Digital ZET

Replaces the paper daily cash sheet for four restaurants under C.A. China
Spice Restaurants LTD.

## Start

```bash
npm install
npm test          # the fixtures should be green before you write anything
```

Then open Claude Code here and work through `docs/PROMPTS.md` one step at a
time. `CLAUDE.md` holds the standing rules; `docs/SPEC.md` is the full spec.

## What is already here

| file | what it is |
|---|---|
| `src/lib/money.ts` | integer-cent parsing and formatting for Greek amounts |
| `src/lib/money.test.ts` | 17 cases from real sheets — includes the `1.234` bug |
| `src/lib/forms.ts` | the four sheets as typed configuration |
| `src/lib/compute.ts` | the reconciliation maths, no DOM, no framework |
| `src/lib/compute.test.ts` | four fixtures taken off real paper |

These are the inheritance from the prototype. The UI is written fresh.
