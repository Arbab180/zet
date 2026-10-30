'use client';

import React from 'react';
import { amountDisplay, rawFromEdit } from '../lib/money';

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  /** What was typed, exactly as it is stored in the draft and sent. */
  value: string;
  /** Called with what was typed — never with the shown text. */
  onValue: (raw: string) => void;
};

/**
 * A money box. It shows an auto-decimal figure with its comma as it is
 * typed (1946 shows 19,46 — see AUTO_DECIMAL in lib/money.ts) but keeps
 * and hands back what was typed, so the draft, the server and the live
 * totals all read the same text through the same parseCents.
 */
export function AmountInput({ value, onValue, inputMode = 'decimal', ...rest }: Props) {
  return (
    <input
      {...rest}
      type="text"
      inputMode={inputMode}
      value={amountDisplay(value)}
      onChange={(e) => onValue(rawFromEdit(value, e.target.value))}
    />
  );
}
