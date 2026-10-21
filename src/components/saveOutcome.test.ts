import { describe, expect, it, vi } from 'vitest';
import {
  MSG_SAVE_NO_RESPONSE,
  MSG_SAVE_OFFLINE,
  bannerMessages,
  callSave,
  settlesWithin,
  type SaveOutcome,
} from './saveOutcome';
import { MSG_DATE, MSG_MANAGER, MSG_PHOTO_CHECK_FIRST } from '../lib/messages';

describe('bannerMessages', () => {
  it('shows the receipt-check refusal — the line that was once shown nowhere', () => {
    const result: SaveOutcome = {
      ok: false,
      error: 'missing_fields',
      messages: [MSG_PHOTO_CHECK_FIRST],
    };
    // The live checklist is empty: the date, manager and signature are all in.
    expect(bannerMessages(result, [])).toEqual([MSG_PHOTO_CHECK_FIRST]);
  });

  it('shows a server missing line the browser check did not produce', () => {
    // e.g. a date the browser accepted as non-empty but the server rejects.
    const result: SaveOutcome = { ok: false, error: 'missing_fields', messages: [MSG_DATE] };
    expect(bannerMessages(result, [])).toEqual([MSG_DATE]);
  });

  it('does not repeat lines the live checklist already shows', () => {
    const result: SaveOutcome = {
      ok: false,
      error: 'missing_fields',
      messages: [MSG_MANAGER, MSG_PHOTO_CHECK_FIRST],
    };
    expect(bannerMessages(result, [MSG_MANAGER])).toEqual([MSG_PHOTO_CHECK_FIRST]);
  });

  it('shows every other failure in full', () => {
    const result: SaveOutcome = { ok: false, error: 'not_authorised', messages: ['x'] };
    expect(bannerMessages(result, ['x'])).toEqual(['x']);
  });

  it('shows nothing for no result or a success', () => {
    expect(bannerMessages(null, [])).toEqual([]);
    expect(
      bannerMessages({ ok: true, reportId: 'r', revisionNo: 1, status: 'submitted' } as SaveOutcome, [])
    ).toEqual([]);
  });
});

describe('callSave', () => {
  it('passes a server result through untouched', async () => {
    const result = { ok: false as const, error: 'conflict' as const, messages: ['c'] };
    expect(await callSave(async () => result, {})).toBe(result);
  });

  it('turns a thrown action into a visible failure, never a rejection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await callSave(async () => {
      throw new TypeError('Failed to fetch');
    }, {}, () => true);
    expect(out).toEqual({ ok: false, error: 'no_response', messages: [MSG_SAVE_NO_RESPONSE] });
  });

  it('says the device is offline when it is', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await callSave(async () => {
      throw new TypeError('Failed to fetch');
    }, {}, () => false);
    expect(out).toEqual({ ok: false, error: 'offline', messages: [MSG_SAVE_OFFLINE] });
  });

  it('treats a non-result response as no answer', async () => {
    const out = await callSave(async () => undefined as never, {});
    expect(out.ok).toBe(false);
    expect(!out.ok && out.messages).toEqual([MSG_SAVE_NO_RESPONSE]);
  });
});

describe('settlesWithin', () => {
  it('is true when the work finishes, even by failing', async () => {
    expect(await settlesWithin(Promise.resolve(), 50)).toBe(true);
    expect(await settlesWithin(Promise.reject(new Error('upload failed')), 50)).toBe(true);
  });

  it('is false when the work hangs', async () => {
    vi.useFakeTimers();
    const hung = new Promise<void>(() => {});
    const result = settlesWithin(hung, 45_000);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await result).toBe(false);
    vi.useRealTimers();
  });
});
