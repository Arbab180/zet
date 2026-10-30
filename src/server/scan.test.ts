import { describe, expect, it } from 'vitest';
import { scanReceipt } from './scan';
import { parsePrintedCents } from '../lib/money';

const CONFIG = { apiKey: 'test-key', model: 'test-model' };

/** A fetch that answers with `text` as the model's reply. */
function replying(text: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

async function scan(text: string) {
  return scanReceipt(Buffer.from('x'), 'image/jpeg', parsePrintedCents, CONFIG, replying(text));
}

const HEAD =
  '"total": "49,92", "supplier": "ALPHAMEGA", "invoiceNumber": "163704", ' +
  '"date": "2026-08-01", "totalLabel": "Total EURO", "confidence": "high"';

describe('scanReceipt — items', () => {
  it('reads the item lines alongside the total', async () => {
    const out = await scan(
      `{${HEAD}, "items": [` +
        '{"name": "ΝΤΟΜΑΤΕΣ", "qty": "1,250 kg", "amount": "3,12"},' +
        '{"name": "ΓΑΛΑ 1L", "qty": "2", "amount": "2,80"}]}'
    );
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    expect(out.result.totalCents).toBe(4992);
    expect(out.result.items).toEqual([
      { name: 'ΝΤΟΜΑΤΕΣ', qty: '1,250 kg', amountCents: 312 },
      { name: 'ΓΑΛΑ 1L', qty: '2', amountCents: 280 },
    ]);
  });

  it('keeps an item whose price it could not read, without inventing one', async () => {
    const out = await scan(
      `{${HEAD}, "items": [` +
        '{"name": "ΨΩΜΙ", "qty": "", "amount": null},' +
        '{"name": "ΤΥΡΙ", "qty": "1", "amount": "2 x 3,10"},' +
        '{"name": "ΔΩΡΟ", "qty": "1", "amount": "0,00"},' +
        '{"name": "", "qty": "1", "amount": "1,00"}, 7]}'
    );
    if (!out.ok) throw new Error('expected a result');
    expect(out.result.items).toEqual([
      { name: 'ΨΩΜΙ', qty: '', amountCents: null },
      // Not a bare figure, so not a price — rather than whatever a lenient
      // parser would make of it.
      { name: 'ΤΥΡΙ', qty: '1', amountCents: null },
      // A line printed as free is a real line and keeps its zero.
      { name: 'ΔΩΡΟ', qty: '1', amountCents: 0 },
      // The nameless line and the stray number are dropped.
    ]);
  });

  it('answers with no items when the reply has none — the shape before items existed', async () => {
    const out = await scan(`{${HEAD}}`);
    if (!out.ok) throw new Error('expected a result');
    expect(out.result.items).toEqual([]);
    expect(out.result.totalCents).toBe(4992);
  });

  it('keeps the total when a long receipt is cut off inside the item list', async () => {
    // What running into max_tokens looks like: the object never closes.
    // Losing a readable total to an unreadable tail would make the scan
    // WORSE on exactly the receipts with the most on them.
    const out = await scan(
      `{${HEAD},\n  "items": [{"name": "ΝΤΟΜΑΤΕΣ", "qty": "1", "amount": "3,12"}, {"name": "ΓΑΛ`
    );
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    expect(out.result.totalCents).toBe(4992);
    expect(out.result.supplier).toBe('ALPHAMEGA');
    expect(out.result.items).toEqual([]);
  });

  it('never returns more than sixty items', async () => {
    const many = Array.from({ length: 80 }, (_, i) => `{"name": "A${i}", "qty": "", "amount": "1,00"}`);
    const out = await scan(`{${HEAD}, "items": [${many.join(',')}]}`);
    if (!out.ok) throw new Error('expected a result');
    expect(out.result.items).toHaveLength(60);
  });

  it('still reports an unreadable reply as unreadable', async () => {
    expect(await scan('I cannot read this image.')).toMatchObject({ ok: false, error: 'unreadable' });
  });
});
