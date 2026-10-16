/**
 * Prints the ADMIN_PASSWORD_HASH line for .env.local.
 *
 *   npm run hash-password
 *
 * Reads the password from a prompt with echo off, NOT from argv: a password
 * passed as an argument lands in shell history and in the process list,
 * where any other user on the machine can read it.
 */

import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/lib/password.ts';

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = process.stdout as NodeJS.WriteStream & { muted?: boolean };
    // Swallow the echoed characters so the password never appears.
    const write = out.write.bind(out);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(question)) write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      write('\n');
      resolve(answer);
    });
  });
}

const password = await ask('New admin password: ');
const again = await ask('Repeat it: ');

if (!password) {
  console.error('\nEmpty password — nothing written.');
  process.exit(1);
}
if (password !== again) {
  console.error('\nThey do not match — nothing written.');
  process.exit(1);
}
if (password.length < 12) {
  console.error(
    `\nThat is ${password.length} characters. This is the admin account and it opens every` +
      "\nrestaurant's takings — use at least 12, ideally a passphrase."
  );
  process.exit(1);
}

const hash = await hashPassword(password);

console.log('\nAdd these to .env.local (never commit it):\n');
// Every `$` escaped: Next.js expands `$NAME` in .env files, quoted or not,
// so a bare `scrypt$32768$8$1$...` loads as just `scrypt` and every login
// fails as a wrong password.
console.log(`ADMIN_PASSWORD_HASH=${hash.replaceAll('$', '\\$')}`);
console.log(`SESSION_SECRET=${randomBytes(48).toString('base64url')}`);
console.log('\nThe secret above is freshly generated. Changing it later signs everyone out.\n');

// A host's secret store (Firebase / Google Secret Manager) takes the value
// literally — no .env parsing — so there the hash must have NO backslashes.
// Pasting the escaped form above into a secret makes every login fail.
console.log('For a HOST secret store (Firebase), paste these instead — no backslashes:\n');
console.log(`  zet-admin-password-hash   ${hash}`);
console.log('  zet-session-secret        (generate a separate one: run this again, or');
console.log("                            node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\")\n");
