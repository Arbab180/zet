import { describe, expect, it } from 'vitest';
import { parseCreateLogin, parseResetPassword } from './accounts';

const good = {
  restaurantId: 'anamma',
  username: 'anamma',
  name: 'ΑΝΑΜΜΑ',
  password: 'ten chars!',
  confirm: 'ten chars!',
};

describe('parseCreateLogin', () => {
  it('accepts a complete form and lower-cases the username', () => {
    const r = parseCreateLogin({ ...good, username: '  Anamma.Ledra ' }, 'admin');
    expect(r).toMatchObject({ ok: true, data: { username: 'anamma.ledra', restaurantId: 'anamma' } });
  });

  it('never trims the password', () => {
    const r = parseCreateLogin({ ...good, password: ' ten chars ', confirm: ' ten chars ' }, 'admin');
    expect(r.ok && r.data.password).toBe(' ten chars ');
  });

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['an unknown restaurant', { restaurantId: 'mcdonalds' }, 'bad_restaurant'],
    ['a username with spaces', { username: 'ana mma' }, 'bad_username'],
    ['a Greek username', { username: 'αναμμα' }, 'bad_username'],
    ['a two-letter username', { username: 'an' }, 'bad_username'],
    ['an empty name', { name: '   ' }, 'name_required'],
    ['a short password', { password: 'short', confirm: 'short' }, 'password_short'],
    ['passwords that differ', { confirm: 'ten chars?' }, 'password_mismatch'],
    ['a missing field', { password: undefined }, 'failed'],
  ];
  for (const [what, over, error] of cases) {
    it(`refuses ${what}`, () => {
      const r = parseCreateLogin({ ...good, ...over }, 'admin');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe(error);
    });
  }

  it("refuses the admin's own username, whatever its case", () => {
    expect(parseCreateLogin({ ...good, username: 'ADMIN' }, 'admin')).toEqual({
      ok: false,
      error: 'reserved_username',
    });
  });

  it('refuses something that is not a form at all', () => {
    expect(parseCreateLogin(null, 'admin').ok).toBe(false);
    expect(parseCreateLogin('anamma', 'admin').ok).toBe(false);
  });
});

describe('parseResetPassword', () => {
  const id = '22222222-2222-2222-2222-222222222222';

  it('accepts a user id and a matching pair', () => {
    expect(parseResetPassword({ userId: id, password: 'ten chars!', confirm: 'ten chars!' })).toEqual({
      ok: true,
      data: { userId: id, password: 'ten chars!' },
    });
  });

  it('refuses a user id that is not a uuid', () => {
    expect(parseResetPassword({ userId: "1' OR 1=1", password: 'ten chars!', confirm: 'ten chars!' }))
      .toEqual({ ok: false, error: 'bad_user' });
  });

  it('refuses a mismatched pair', () => {
    expect(parseResetPassword({ userId: id, password: 'ten chars!', confirm: 'other one!' }))
      .toEqual({ ok: false, error: 'password_mismatch' });
  });
});
