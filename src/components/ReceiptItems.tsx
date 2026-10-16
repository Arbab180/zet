'use client';

import { useState } from 'react';
import { formatCents, sanitizeAmountInput } from '../lib/money';
import {
  MAX_ITEM_NAME,
  MAX_ITEM_QTY,
  MAX_RECEIPT_ITEMS,
  blankItem,
  itemsDifference,
  itemsTotalCents,
  type ReceiptItemInput,
} from '../lib/receiptItems';
import {
  MSG_ITEMS,
  MSG_ITEMS_ADD,
  MSG_ITEMS_ADD_FIRST,
  MSG_ITEMS_COUNT,
  MSG_ITEMS_DIFFERENCE,
  MSG_ITEMS_FROM_PHOTO,
  MSG_ITEMS_TOTAL,
  MSG_ITEM_AMOUNT,
  MSG_ITEM_NAME,
  MSG_ITEM_QTY,
  MSG_ITEM_REMOVE,
} from '../lib/messages';
import styles from './ReceiptItems.module.css';

/**
 * The breakdown under one receipt line: what was bought, how much, what
 * each line cost. Filled by the scan, corrected by hand, or typed from
 * nothing.
 *
 * One component for both sheets, so the ledger's expenses and the shifts
 * sheet's invoices cannot drift apart on how items behave.
 *
 * It never changes the receipt's amount and never blocks anything. When
 * the items do not add up to the amount it says so and leaves both alone
 * (see src/lib/receiptItems.ts).
 */
export default function ReceiptItems({
  items,
  onChange,
  lineAmount,
  rowLabel,
  fromScan = false,
}: {
  items: ReceiptItemInput[];
  onChange: (next: ReceiptItemInput[]) => void;
  /** The receipt's own amount, as typed, to compare the items against. */
  lineAmount: string;
  /** Names the receipt for screen readers, e.g. "Έξοδο 3". */
  rowLabel: string;
  /** The list is still exactly what the scan read. */
  fromScan?: boolean;
}) {
  // Open by default: a list that arrives from the scan is something to
  // look at, and one being typed is something being used. Held in state
  // because a bare `open` attribute would re-open it on every keystroke.
  const [open, setOpen] = useState(true);

  if (items.length === 0) {
    return (
      <button type="button" className={styles.addFirst} onClick={() => onChange([blankItem()])}>
        {MSG_ITEMS_ADD_FIRST}
      </button>
    );
  }

  const total = itemsTotalCents(items);
  const difference = itemsDifference(items, lineAmount);

  function setItem(index: number, patch: Partial<ReceiptItemInput>) {
    onChange(items.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  }

  return (
    <details
      className={styles.items}
      open={open}
      onToggle={(ev) => setOpen(ev.currentTarget.open)}
    >
      <summary className={styles.summary}>
        <span>
          {MSG_ITEMS} · {MSG_ITEMS_COUNT(items.length)}
        </span>
        <span className={styles.summaryTotal}>{formatCents(total)}</span>
      </summary>

      {fromScan && <p className={styles.fromScan}>{MSG_ITEMS_FROM_PHOTO}</p>}

      <div className={styles.head} aria-hidden="true">
        <span>{MSG_ITEM_NAME}</span>
        <span>{MSG_ITEM_QTY}</span>
        <span className={styles.headAmount}>{MSG_ITEM_AMOUNT}</span>
        <span />
      </div>

      {items.map((it, i) => (
        <div className={styles.row} key={i}>
          <input
            type="text"
            value={it.name}
            maxLength={MAX_ITEM_NAME}
            onChange={(ev) => setItem(i, { name: ev.target.value })}
            aria-label={`${rowLabel} — ${MSG_ITEM_NAME} ${i + 1}`}
          />
          <input
            type="text"
            value={it.qty}
            maxLength={MAX_ITEM_QTY}
            onChange={(ev) => setItem(i, { qty: ev.target.value })}
            aria-label={`${rowLabel} — ${MSG_ITEM_QTY} ${i + 1}`}
          />
          <input
            type="text"
            inputMode="decimal"
            className={styles.amount}
            value={it.amount}
            onChange={(ev) => setItem(i, { amount: sanitizeAmountInput(ev.target.value) })}
            aria-label={`${rowLabel} — ${MSG_ITEM_AMOUNT} ${i + 1}`}
          />
          <button
            type="button"
            className={styles.remove}
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            aria-label={`${MSG_ITEM_REMOVE} ${i + 1} — ${rowLabel}`}
          >
            ×
          </button>
        </div>
      ))}

      <div className={styles.foot}>
        {items.length < MAX_RECEIPT_ITEMS ? (
          <button
            type="button"
            className={styles.add}
            onClick={() => onChange([...items, blankItem()])}
          >
            {MSG_ITEMS_ADD}
          </button>
        ) : (
          <span />
        )}
        <span className={styles.footTotal}>
          {MSG_ITEMS_TOTAL} {formatCents(total)}
        </span>
      </div>

      {difference && difference.differenceCents !== 0 && (
        <p className={styles.difference} role="status">
          {MSG_ITEMS_DIFFERENCE(
            formatCents(difference.itemsCents),
            formatCents(difference.lineCents),
            formatCents(Math.abs(difference.differenceCents))
          )}
        </p>
      )}
    </details>
  );
}
