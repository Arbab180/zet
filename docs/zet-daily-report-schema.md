# ZET — Daily Cash Report (page 2) — Data Schema

Source: paper form `ΕΝΤΥΠΟ Τ ΑΝΑΜΜΑ-01_ΧΑ/γμ`, ΤΟ ΑΝΑΜΜΑ (C.A. China Spice Restaurants LTD), sample dated 14/09/26.

This is the schema for **one page** of the ZET: the evening cash reconciliation. It does not cover employee hours — that lives on a different sheet and needs its own schema.

---

## 1. What the form actually does

It is a single subtraction chain that ends in "how much cash should be in the envelope":

```
DAILY REPORT TOTAL          (POS Z-report gross)
  − VISA CARD 1
  − VISA CARD 2
  = TOTAL                   (row 1)
  − FOODY ΟΛΙΚΟ
  − B3
  − WOLT ΟΛΙΚΟ
  − BOLT ΟΛΙΚΟ
  − ΕΠΙΤΑΓΕΣ                (cheques)
  − ΑΠΟΔΕΙΞΕΙΣ ΠΟΥ ΕΚΚΡΕΜΟΥΝ ΠΛΗΡΩΜΗΣ   (receipts pending payment)
  = TOTAL                   (row 2 — cash sales before expenses)
  − * ΣΥΝΟΛΙΚΑ ΕΞΟΔΑ ΗΜΕΡΑΣ (total from the expenses block below)
  = ΜΕΤΡΗΤΑ ΣΤΟΝ ΦΑΚΕΛΟ     (cash in envelope)
```

Check against the sample: `2165.00 − 1640.33 = 524.67`; `524.67 − 84.80 − 31.80 = 408.07`. The expenses block is blank, so expenses = 0 and cash = **408.07** — which matches the €408.07 written in the margin with "OK" and initials.

**But** on the paper, 408.07 was written on the `ΣΥΝΟΛΙΚΑ ΕΞΟΔΑ ΗΜΕΡΑΣ` row, not the `TOTAL` row above it. Both `TOTAL` rows were left blank, and the `ΜΕΤΡΗΤΑ ΣΤΟΝ ΦΑΚΕΛΟ` box was filled in then erased/taped over. That is exactly the class of error the digital version removes: every `TOTAL` and `=` row becomes computed and read-only, and the only numbers a human types are the ones that come from outside (Z-report, terminal, platform, receipts, counted cash).

Also on the form:

- FOODY and WOLT each have **α)…ε)** — five slots to itemise individual orders. B3 has **α)…ζ)** — six. BOLT has none printed.
- ΕΠΙΤΑΓΕΣ note: cheques are issued to *C.A. China Spice Restaurants LTD*, and the customer's **name & phone must be written clearly on the back**.
- ΑΠΟΔΕΙΞΕΙΣ ΠΟΥ ΕΚΚΡΕΜΟΥΝ note: for organisations with a deferred-payment agreement (e.g. ΚΟΤ, Δήμος Λ/σίας, taxi office). On the receipt write: **organisation name, contact person, phone, signature**.
- Expenses block: ~14 blank rows, `ΠΕΡΙΓΡΑΦΗ ΕΞΟΔΩΝ` / `ΠΟΣΟ €`, with its own total.
- Footer: `ΟΝΟΜΑ ΥΠΕΥΘΥΝΟΥ ΤΑΜΕΙΟΥ (βράδυ)` + `ΥΠΟΓΡΑΦΗ`.

---

## 2. Design decisions

**Money is integer cents, never float.** `0.1 + 0.2 !== 0.3` in JavaScript, and a reconciliation form that is off by €0.01 will be rejected by whoever signs it. Store `Cents` (integer), format at the edge.

**Two cash numbers, not one.** The paper has one box. The app needs *expected* (computed) and *counted* (what the manager physically put in the envelope). The gap between them is the whole point of the control — without it you can't tell a short till from a typo.

**Business date ≠ created date.** A shift closing at 01:30 belongs to the previous trading day. One report per restaurant per business date, enforced by a unique constraint.

**Platforms as rows, not columns.** FOODY/WOLT/BOLT/B3 are hardcoded on the paper. Delivery platforms change. Use a `platform` table and reference it, so adding one is a row, not a migration + form rewrite.

**Fixed sub-slots become unlimited arrays.** The paper caps FOODY at five orders because that's what fits. The app shouldn't inherit a paper constraint.

---

## 3. TypeScript types

```ts
/** EUR in integer cents. 408.07 → 40807. Never store money as a float. */
type Cents = number;

type ReportStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

interface ZetDailyReport {
  id: string;
  restaurantId: string;
  formRef: string;              // 'ΕΝΤΥΠΟ Τ ΑΝΑΜΜΑ-01_ΧΑ/γμ'
  businessDate: string;         // 'YYYY-MM-DD' — trading day, not createdAt
  status: ReportStatus;

  /** DAILY REPORT TOTAL — gross from the POS Z-report. Typed by a human. */
  grossDailyTotal: Cents;

  cardSettlements: CardSettlement[];
  platformSales: PlatformSale[];
  cheques: Cheque[];
  pendingPaymentReceipts: PendingPaymentReceipt[];
  expenses: ExpenseLine[];

  /** ΜΕΤΡΗΤΑ ΣΤΟΝ ΦΑΚΕΛΟ — cash actually counted into the envelope. */
  cashCounted: Cents;
  /** Required when |variance| exceeds the tolerance. */
  varianceNote?: string;

  closingManagerName: string;   // ΟΝΟΜΑ ΥΠΕΥΘΥΝΟΥ ΤΑΜΕΙΟΥ (βράδυ)
  signatureImageUrl?: string;   // ΥΠΟΓΡΑΦΗ
  sourcePhotoUrl?: string;      // photo of the paper form, during transition

  createdAt: string;            // ISO timestamp
  createdBy: string;            // user id
  submittedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
}

interface CardSettlement {
  id: string;
  /** 'VISA CARD 1' | 'VISA CARD 2' | … — terminal, not card brand. */
  terminalLabel: string;
  provider: string;             // 'jcc smart-EUR€'
  amount: Cents;
}

interface PlatformSale {
  id: string;
  platformId: string;           // → platform table (FOODY, WOLT, BOLT, B3)
  /** The α)…ε) / α)…ζ) slots. Optional: some nights only the total is known. */
  orders: Cents[];
  /** ΟΛΙΚΟ. Must equal sum(orders) when orders is non-empty. */
  total: Cents;
}

interface Cheque {
  id: string;
  amount: Cents;
  customerName: string;         // required — form demands it on the back
  customerPhone: string;        // required
  chequeNumber?: string;
  bank?: string;
  photoUrl?: string;
}

interface PendingPaymentReceipt {
  id: string;
  amount: Cents;
  organisationName: string;     // e.g. ΚΟΤ, Δήμος Λ/σίας
  contactPerson: string;
  contactPhone: string;
  receiptNumber?: string;
  photoUrl?: string;
  settledAt?: string;           // null until they actually pay
}

interface ExpenseLine {
  id: string;
  description: string;          // ΠΕΡΙΓΡΑΦΗ ΕΞΟΔΩΝ
  amount: Cents;                // ΠΟΣΟ €
  receiptPhotoUrl?: string;     // → hand-off to the AI invoicing project
  supplierId?: string;          // filled by matching, not by the user
  categoryId?: string;
}
```

---

## 4. Derived values — computed, never stored as user input

```ts
interface ZetTotals {
  cardTotal: Cents;             // TOTAL row 1 input
  subtotalAfterCards: Cents;    // TOTAL row 1
  platformTotal: Cents;
  chequeTotal: Cents;
  pendingTotal: Cents;
  subtotalCashSales: Cents;     // TOTAL row 2
  expensesTotal: Cents;         // * ΣΥΝΟΛΙΚΑ ΕΞΟΔΑ ΗΜΕΡΑΣ
  cashExpected: Cents;          // what ΜΕΤΡΗΤΑ ΣΤΟΝ ΦΑΚΕΛΟ should be
  variance: Cents;              // cashCounted − cashExpected
}

const sum = (xs: Cents[]): Cents => xs.reduce((a, b) => a + b, 0);

function computeTotals(r: ZetDailyReport): ZetTotals {
  const cardTotal = sum(r.cardSettlements.map(c => c.amount));
  const subtotalAfterCards = r.grossDailyTotal - cardTotal;

  const platformTotal = sum(r.platformSales.map(p => p.total));
  const chequeTotal = sum(r.cheques.map(c => c.amount));
  const pendingTotal = sum(r.pendingPaymentReceipts.map(p => p.amount));

  const subtotalCashSales =
    subtotalAfterCards - platformTotal - chequeTotal - pendingTotal;

  const expensesTotal = sum(r.expenses.map(e => e.amount));
  const cashExpected = subtotalCashSales - expensesTotal;

  return {
    cardTotal, subtotalAfterCards,
    platformTotal, chequeTotal, pendingTotal,
    subtotalCashSales, expensesTotal,
    cashExpected,
    variance: r.cashCounted - cashExpected,
  };
}
```

Store `cashExpected` and `variance` on the row anyway — denormalised — so reports and alerts don't have to recompute across every child table. Recompute on every write; never trust a client-sent total.

---

## 5. Validation rules

| # | Rule | Severity | Why |
|---|---|---|---|
| 1 | All amounts are integers ≥ 0 | block | negatives are entered as line types, not minus signs |
| 2 | `grossDailyTotal > 0` | block | a day with no Z-report total is an incomplete form |
| 3 | `platform.total === sum(platform.orders)` when orders present | block | catches a mistyped slot |
| 4 | One report per `(restaurantId, businessDate)` | block | DB unique constraint |
| 5 | `businessDate` not in the future; not older than N days without an override | block | stops backdating |
| 6 | `subtotalAfterCards >= 0` | block | card settlements exceeding gross means a wrong number somewhere |
| 7 | `cashExpected >= 0` | warn + note | possible, but almost always an error |
| 8 | `abs(variance) > €1.00` | warn + `varianceNote` required | the core control |
| 9 | `abs(variance) > €20.00` | block submit; manager approval required | escalation |
| 10 | Cheque requires `customerName` + `customerPhone` | block | the form explicitly requires it |
| 11 | Pending receipt requires org + contact person + phone | block | same |
| 12 | Expense line requires description + amount > 0 | block | blank rows are not expenses |
| 13 | Expense > €X requires `receiptPhotoUrl` | warn | feeds the invoicing project |
| 14 | `closingManagerName` set before submit | block | accountability |
| 15 | Approved reports are immutable; corrections are a new versioned revision | block | audit trail |

Rule 8 is the one that earns the whole system. Everything above it just makes the number trustworthy.

> **Note (2026-09-22):** rules 8 and 9 were relaxed in the prototype at the user's
> request — no hard amount ceilings, and the agreement checks are informational
> rather than blocking. See `docs/SPEC.md` §5 for the authoritative current
> behaviour. This table records the original intent.

---

## 6. Storage sketch (Postgres)

```
restaurant            (id, name, legal_entity, form_ref, timezone, active)
platform              (id, code, display_name, active, sort_order)
card_terminal         (id, restaurant_id, label, provider, active)
app_user              (id, name, email, role)           -- staff | manager | admin
restaurant_user       (restaurant_id, user_id, role)    -- who can file for which

zet_daily_report      (id, restaurant_id, business_date, status,
                       gross_daily_total_cents, cash_counted_cents,
                       cash_expected_cents, variance_cents, variance_note,
                       closing_manager_name, signature_url, source_photo_url,
                       created_at, created_by, submitted_at,
                       approved_at, approved_by,
                       UNIQUE (restaurant_id, business_date))

zet_card_settlement   (id, report_id, card_terminal_id, amount_cents)
zet_platform_sale     (id, report_id, platform_id, total_cents)
zet_platform_order    (id, platform_sale_id, slot_index, amount_cents)
zet_cheque            (id, report_id, amount_cents, customer_name,
                       customer_phone, cheque_number, bank, photo_url)
zet_pending_receipt   (id, report_id, amount_cents, organisation_name,
                       contact_person, contact_phone, receipt_number,
                       photo_url, settled_at)
zet_expense           (id, report_id, line_no, description, amount_cents,
                       receipt_photo_url, supplier_id, category_id)
zet_report_revision   (id, report_id, revision_no, snapshot_jsonb,
                       changed_by, changed_at, reason)
```

All money columns `bigint`, named `*_cents` so nobody is ever unsure what the unit is. `ON DELETE CASCADE` from `report_id`, except revisions.

---

## 7. Hand-off to the AI invoicing project

`zet_expense.receipt_photo_url` is the join. The pipeline:

```
photo → OCR/extract → {supplier, date, total, VAT, line items}
      → match against zet_expense.amount_cents for that business_date
      → confident match: attach + set supplier_id
      → no match / ambiguous: queue for human review
```

Two things to decide early, because they change the schema:

- Does an invoice ever cover **several** ZET expense lines (or vice versa)? If yes, the link is a join table, not a foreign key on `zet_expense`.
- Is a cash expense in the ZET the *same* record as a supplier invoice, or two records that reconcile against each other? They aren't the same thing — a cash purchase and a 30-day supplier invoice hit the books differently.

---

## 8. Open questions

1. **What is B3?** It sits with the delivery platforms and has six sub-slots instead of five. A platform, a specific customer account, or something else? It changes whether it belongs in the `platform` table.
2. **BOLT has no printed sub-slots** — deliberate, or just no room on the page? Affects whether order itemisation is per-platform configurable.
3. **Is this page 2 of 2?** The sheet is numbered "2" and there's a second `Ημερομηνία:` at the very bottom, suggesting a continuation. Page 1 likely holds the employee hours.
4. **Opening float.** Nothing on this page accounts for a till float. Is it fixed and excluded, or does it need to enter the chain?
5. **Cheques and pending receipts** — both are money owed, tracked here once and then never followed up on paper. Should the app chase settlement, or is that a separate ledger?
6. **How many restaurants**, and do they all use this exact form? If the forms differ, the line items need to be configuration, not hardcoded fields. (Answered: four, and they differ — see `docs/SPEC.md` §3–4.)
