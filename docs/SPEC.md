# Digital ZET — build spec for Claude Code

Everything needed to build the production app, extracted from a working prototype that
was validated against four real paper sheets.

**Read this first, then build fresh.** Do not port the prototype's DOM code — it is
imperative vanilla JS and converting it to React yields React-shaped vanilla JS. Take the
**configuration**, the **money rules** and the **reconciliation maths** from here; write
the UI from scratch.

Prototype: `claude.ai/artifact/9Xx1Fah5V6n4cnAwdjXfGq` (private). Related project doc:
`claude/zet-daily-report-schema.md`.

---

## 1. What this is

Four restaurants under **C.A. China Spice Restaurants LTD** close their till each night on
a paper form. Someone photographs it. The figures get re-typed later, and mistakes are
found days afterwards or not at all.

The app replaces the paper. A manager fills the same sheet on a phone at closing time, the
arithmetic is done for them, and the record is stored.

It must eventually feed the AI invoicing project — receipt photo → amount → supplier
invoice.

### The four sheets

| id | Restaurant | Form ref | Layout |
|---|---|---|---|
| `anamma` | ΤΟ ΑΝΑΜΜΑ, Λήδρας 87, Λευκωσία · 22210200 | ΕΝΤΥΠΟ Τ ΑΝΑΜΜΑ-01_ΧΑ/γμ | ledger |
| `chop_engomi` | CHOPSTICKS, Shop 27 Mall of Engomi, 7-9 28th October, 2414 Λευκωσία · 22832283 | ΕΝΤΥΠΟ Τ-ΒΜΒ-01_ΧΑ/γμ | ledger |
| `chop_pindarou` | CHOPSTICKS, Πινδάρου 26, 1060 Λευκωσία · 22451111 | ΕΝΤΥΠΟ Τ-ΒΜΒ-01_ΧΑ/γμ | ledger |
| `chop_cyprus` | CHOPSTICKS, Mall of Cyprus, Verginas 3, Strovolos 2030 · 22570707 | ΕΝΤΥΠΟ Τ-ΒΜΒ-01_ΧΑ/γμ | ledger |
| `chop_lakatamia` | CHOPSTICKS, Arch. Makarios III Avenue, Λακατάμια · 22454400 | ΕΝΤΥΠΟ Τ-ΒΜΒ-01_ΧΑ/γμ | ledger |
| `china_spice` | CHINASPICE@MONTPARNASSE (was CHINA SPICE · Πινδάρου 26), Akropoleos 1 · τηλ 22875875 | — | shifts |

Two layouts, not four. The Chopsticks branches share one form with different letterhead.

---

## 2. Money — get this right before anything else

### Integer cents, never floats

`0.1 + 0.2 !== 0.3`. A reconciliation off by one cent is rejected by whoever signs it.
Store `bigint` cents in the database, name every column `*_cents`, format only at the edge.

### Parsing Greek amounts

Cyprus writes `1.234,56`. The dot is a **thousands separator**. This parser handles both
conventions, and the commented rule is the part that matters:

```js
function parseC(str){
  if(str==null) return 0;
  var s = String(str).trim().replace(/[€\s]/g,'');
  if(!s) return 0;
  var lc=s.lastIndexOf(','), ld=s.lastIndexOf('.');
  if(lc>-1 && ld>-1){
    // both marks present: whichever comes last is the decimal one
    s = lc>ld ? s.replace(/\./g,'').replace(/,/g,'.') : s.replace(/,/g,'');
  } else if(lc>-1 || ld>-1){
    // one mark only. el-GR groups thousands, so "1.234" is 1234, not 1.234 —
    // treat it as a group separator when it repeats or leaves exactly 3 digits.
    var sep = lc>-1 ? ',' : '.';
    var last = lc>-1 ? lc : ld;
    var parts = s.split(sep);
    s = (parts.length>2 || (s.length-last-1)===3) ? parts.join('') : parts.join('.');
  }
  var n=parseFloat(s); return isFinite(n)?Math.round(n*100):0;
}
```

**Port these tests before porting the function.** An earlier version lacked the
single-dot branch and read `1.234` as €1,23 — a day's takings recorded as one euro
twenty-three. It passed every manual check because the sample sheets all used commas.

| input | expected cents |
|---|---|
| `2165,00` | 216500 |
| `1.640,33` | 164033 |
| `1640.33` | 164033 |
| `1.234` | **123400** |
| `12.34` | 1234 |
| `1.2` | 120 |
| `123.456` | 12345600 |
| `1.234.567` | 123456700 |
| `1234` | 123400 |
| `0,5` | 50 |
| `1,234` | 123400 |
| `5` | 500 |
| `408,07` | 40807 |
| `2.592,90` | 259290 |
| `` (empty) | 0 |

Display with `Intl.NumberFormat('el-GR', {minimumFractionDigits:2, maximumFractionDigits:2})`.

### Input guarding

Strip anything that is not `0-9 . ,` as the user types. A letter otherwise parses to `0`
and silently eats a real figure.

**Identify money fields by what they are — a type or a flag — never by an id prefix.** The
prototype used `/^f_/` and so treated the *name* and *date* fields as money, stripping
their contents. A naming convention is not a type.

No upper limit on amounts. A big number is usually a real day, and a wrong one shows up in
the reconciliation anyway.

---

## 3. Layout A — `ledger` (ΑΝΑΜΜΑ, both Chopsticks)

A single subtraction chain ending at cash in the envelope.

```
DAILY REPORT TOTAL        (gross, from the POS Z-report)
  − each card settlement
  − each delivery platform
  − cheques
  − receipts pending payment
  − any written-in row
  = cash sales
  − total day expenses
  = ΜΕΤΡΗΤΑ ΣΤΟΝ ΦΑΚΕΛΟ     (expected cash)
```

`variance = counted − expected`, where `counted` is what the manager physically put in the
envelope. **Keep expected and counted as two separate numbers.** The paper has one box;
the gap between them is the entire control.

### Rows, in order

**ΑΝΑΜΜΑ** — labels centred, `TOTAL` subtotal rows after the cards and after the deductions:

| key | label | note |
|---|---|---|
| `gross` | DAILY REPORT TOTAL | large |
| `card1` | *(jcc smart-EUR€)* VISA CARD 1 | − |
| `card2` | VISA CARD 2 | − |
| `sub1` | TOTAL | computed `=` |
| `FOODY` | FOODY ΟΛΙΚΟ | − , **5** α)…ε) order slots |
| `B3` | B3 | − , **6** α)…ζ) order slots |
| `WOLT` | WOLT ΟΛΙΚΟ | − , **5** slots |
| `BOLT` | BOLT ΟΛΙΚΟ | − |
| `cheques` | ΕΠΙΤΑΓΕΣ | − , itemisable, carries note 1 |
| `pending` | ΑΠΟΔΕΙΞΕΙΣ ΠΟΥ ΕΚΚΡΕΜΟΥΝ ΠΛΗΡΩΜΗΣ | − , itemisable, carries note 2 |
| `sub2` | T O T A L | computed `=` |
| `expenses` | * ΣΥΝΟΛΙΚΑ ΕΞΟΔΑ ΗΜΕΡΑΣ | − , computed from the expense block |

**Both Chopsticks** — labels right-aligned, no subtotal rows, no order slots:

`gross` · `card1` JCC VISA CARD 1 · `card2` SIX VISA CARD 2 · `FOODY` · `B3` · `WOLT` ·
`BOLT` · `blank1` *(printed unlabelled row — the label is writable; this is where staff
hand-write things like `Kiosk`)* · `cheques` ΕΠΙΤΑΓΕΣ ΠΕΛΑΤΩΝ · `expenses`

### The two printed notes, verbatim

1. *(Εκδίδονται στο όνομα C.A. China Spice Restaurants LTD. & απαραίτητα να σημειώνεται με καθαρά γράμματα στο πίσω μέρος της επιταγής, το όνομα & τηλέφωνο του πελάτη)*
2. *Οργανισμοί/Εταιρείες που έχουμε συμφωνία για αποπληρωμή σε μεταγενέστερο στάδιο. Να γράφετε πάνω στην απόδειξη: Όνομα Οργανισμού/Εταιρείας (πχ ΚΟΤ, Δήμος Λ/σίας, όνομα Ταξ. Γραφείου), Άτομο Επαφής, τηλέφωνο και υπογραφή.*

### Expense block

Header `* ΣΥΝΟΛΙΚΑ ΕΞΟΔΑ ΗΜΕΡΑΣ -> ΑΠΟΔΕΙΞΕΙΣ & ΔΙΑΦΟΡΑ` (Chopsticks uses `-` not `->`),
columns `ΠΕΡΙΓΡΑΦΗ ΕΞΟΔΩΝ` / `ΠΟΣΟ €` (Chopsticks: `ΠΕΡΙΓΡΑΦΗ`), **14 printed rows**, then a
computed total. Add a row automatically when the last one is used.

### Verified against the paper

| sheet | inputs | expected cash | on the sheet |
|---|---|---|---|
| ΑΝΑΜΜΑ 14/09/26 | 2165,00 − 1640,33 − 84,80 − 31,80 | **408,07** | 408,07 ✓ |
| Engomi 14/09/26 | 740,04 − 180,84 − 214,98 − 130,73 − 137,10 − 4,30 | **72,09** | 72,09 ✓ |
| Πινδάρου 10/09/26 | 763,36 − 517,70 − 127,75 − 99,30 | **18,61** | 18,61 ✓ |

Use these as fixtures.

Two notes on the Engomi sheet. It only balances if BOLT is **137,10**; read as 127,10 it is
out by €10 — either a misread digit or an uncaught error on the paper. And on the Πινδάρου
sheet WOLT reads 146,13 in the total column but only **127,75** is deducted: a margin note
splits it `127,75 ONLINE / 18,38 CASH`, and the cash part stays in the till. Deciding
whether to model that split is open — see §8.

---

## 4. Layout B — `shifts` (CHINA SPICE)

Completely different. One sheet per day, **three shift columns**: ΜΕΣΗΜΕΡΙ, ΒΡΑΔΥ, ΒΡΑΔΥ.

- **ΤΑΜΕΙΟ block** — per column: `Dine in:`, `T/A:`, `Total:`
- **Payment rows** — CASH · JCC · GAP · FOODY · B3 · STRIPE · WOLT · BOLT · SKASH · one
  blank row. JCC and GAP sit under a vertical `VISA VIS` bracket.
- **Invoices** — free lines per column, each `supplier / invoice number` + amount
- **TOTAL row** — per column

Per shift:

```
expected  = Total − (every non-cash method)
accounted = CASH + invoices paid out of the till      ← this is the printed TOTAL row
diff      = expected − accounted
```

Day figures are the sums across shifts.

**Verified**, ΒΡΑΔΥ column of 10/09/26: Total 2592,90; CASH 408,00; JCC 1437,58;
FOODY 251,80; WOLT 255,10; invoices `SKLAVENITIS 01/601277` 5,40 and
`A.SAVVIDES TYRES ES266231` 130,00.
expected **648,42**, accounted **543,40**, diff **−105,02** — and the sheet carries a
circled handwritten `€105` marked unpaid. The model is right.

Those invoice lines already carry supplier and invoice number. **That is the join into the
invoicing project, printed on the paper.**

---

## 5. Validation — deliberately almost none

Decided after building the strict version: employees are trusted with the cash, so the
form does not argue with their figures.

**Required:** business date (it is the record key), the closing manager's name, a signature.

**Explicitly not enforced:** order slots matching the platform total; itemised
cheques/receipts matching their row; Dine in + T/A matching Total; negative expected cash;
future or old dates; any difference threshold; complete cheque/receipt/expense lines.

Totals and the difference are still **shown**. They inform; they do not block.

Messages are plain Greek instructions, not descriptions of a violation:
`Βάλτε ημερομηνία.` · `Γράψτε ποιος κλείνει το ταμείο.` · `Βάλτε υπογραφή.` ·
`Μόνο αριθμοί` · header `Δεν αποθηκεύτηκε — λείπουν 3 πράγματα`.

Once a save has been attempted the list is **live**: items drop off as they are fixed.
Before the first save attempt it stays silent.

---

## 6. Security — the part to be most sceptical of

None of this exists in the prototype. It is the reason to build the real thing.

1. **Recompute every total server-side** from the raw inputs. Never store a total the
   client posted. Anyone can open devtools and send whatever cash figure they like.
2. **Authorise per restaurant on every request.** Today every viewer shares one archive —
   Engomi staff can read ΑΝΑΜΜΑ's takings. This is the known hole.
3. TypeScript is not a security boundary. Types are erased at runtime; a typed app with no
   auth check is exactly as breakable as an untyped one. Validate at the boundary with Zod
   or equivalent, on the server, on every request.
4. Approved reports are immutable. Corrections are a new versioned revision, never an
   in-place edit.
5. One report per `(restaurant, business_date)` — enforce with a unique constraint, not
   application logic.
6. **Business date ≠ created date.** A shift closing at 01:30 belongs to the previous
   trading day.

Storage sketch is in `claude/zet-daily-report-schema.md`. Note one divergence: that doc
uses `grossCents` at the top level; the prototype nests figures under `values.*`. Pick one
deliberately.

---

## 7. Front-end requirements learned the hard way

- **Phones first.** Managers fill this at 1am on a phone. Test at 320px, not just 390px.
- **Touch targets ≥ 40px**, keyed on `(max-width:700px), (pointer:coarse)` — a tablet is a
  wide screen with fat fingers, so width alone is the wrong test.
- **Never set layout-critical CSS inline.** Inline styles outrank every media query; doing
  this scrambled the entire grid on phones and it went unnoticed because the automated
  check only looked for overflow, not correctness.
- **No `alert` / `confirm` / `prompt`.** Sandboxed frames block them and they fail
  *silently* — `confirm()` returning false read as "cancel" and made a guard into a lock.
  Ask in-page.
- **Draft to local storage, debounced**, and offer to restore on load rather than
  restoring silently. Warn on unload when dirty. A locked phone should not cost a night's
  entry.
- **Wait for storage rather than refusing.** "Cannot save" while the connection is still
  opening is a lie about a save.
- Accessibility that must survive: error list as `role="alert"`; every control labelled;
  contrast ≥ 4.5:1 (the prototype shipped placeholders at 1.71:1); a keyboard-only path to
  signing, since signing gates the save.
- Design: black print on white, entries in ballpoint blue `#1D3E9C`, hairline rules, the
  form's own Greek labels. Staff recognise the sheet instantly, which is most of the
  training done.

---

## 8. Open questions — answer before designing the schema

1. **What is B3?** Sits with the delivery platforms, has six order slots instead of five,
   and is struck through in pen on the Πινδάρου sheet. A platform, an account, or dead?
2. **Do delivery totals need an online/cash split?** The Πινδάρου margin note splits WOLT
   by hand and only the online part is deducted. Currently modelled as one figure, which
   is wrong on any night a delivery is paid in cash.
3. **Is the third ΒΡΑΔΥ column on CHINA SPICE ever used?**
4. **Can one supplier invoice cover several expense lines?** If yes, the link to the
   invoicing project is a join table, not a foreign key.
5. **Is a till float excluded, or does it enter the chain?**
6. **Who may see which restaurant?** Drives the whole authorisation model.

**Get a week of real closings out of the prototype before answering these.** Every one is a
schema decision, and guessing costs a migration.

---

## 9. Receipt scanning

Built and tested in the prototype but **unreachable there** — the artifact sandbox refuses
file selection, so no photo can reach the model however the button is wired.

The front-end is done and transfers directly. What is needed is the endpoint:

```
POST <ZET_SCAN_ENDPOINT>   multipart, field `file`
→ { total, supplier, invoiceNumber, date, confidence }
```

Call the Anthropic API from **your server**, not the browser. The prototype spent each
viewer's personal Claude usage, which was never viable for staff at a till.

Rules that should survive:

- `total` is the amount payable including VAT, or `null` — never a guess.
- `confidence: "high"` only when certain.
- Images are downsized before the model sees them; a crumpled receipt shot from across the
  table will fail. Tell people: close, flat, straight.
- **A scanned figure is a suggestion, not a record.** Show it as editable and visibly
  provisional. The prototype originally blocked saving until each scan was confirmed;
  that was removed on request, but an OCR'd number that flows silently into a cash
  reconciliation is worse than no OCR, because it looks authoritative and nobody re-reads
  it. Whatever you choose, make the choice deliberately.
- Keep the photo with the record. Receipt → amount → invoice is the whole point.

---

## 10. Suggested order

1. `parseC` + the test table. Nothing else until it is green.
2. The form config as typed data, and the two computation functions, unit-tested against
   the three ledger fixtures and the China Spice shift fixture.
3. Schema + migrations, with the unique constraint.
4. Auth and per-restaurant authorisation. Before any UI.
5. The ledger form, on a phone.
6. The shifts form.
7. Drafts, archive, revisions.
8. The scanning endpoint.

Work in the loop that produced this: **build → review → fix → test**. The review has to be
adversarial rather than a read-through — the `1.234` bug passed every manual check and was
only found by a reviewer hunting for what had been assumed.
