import { describe, expect, it } from 'vitest';
import { FORM_ORDER, FORMS } from './forms';

// The empty boxes say where their figure comes from: the Z report, or the
// envelope. Each sheet has to mark its own rows for that to show at all.
describe('where-it-comes-from hints', () => {
  it.each(FORM_ORDER)('%s marks its Z report figure and its envelope cash', (id) => {
    const form = FORMS[id];
    if (form.layout === 'ledger') {
      const z = form.rows.filter((r) => r.kind === 'input' && r.source === 'z_report' && !r.retired);
      expect(z).toHaveLength(1);
      expect(z[0]!.key).toBe('gross');
    } else {
      expect(form.tameioRows.length).toBeGreaterThan(0);
      expect(form.methods.filter((m) => m.isCash && !m.retired)).toHaveLength(1);
    }
  });
});
