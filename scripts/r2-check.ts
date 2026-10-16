/**
 * Diagnoses a failing receipt upload.
 *
 *   npm run r2:check
 *
 * Run it in your own Terminal, where the machine has real internet.
 *
 * A blocked upload gives you one word, and several unrelated causes wear
 * it. This runs four probes from Node — where there is no browser and so
 * no CORS — and reads the verdict off the COMBINATION of results, which
 * is what tells a read-only token apart from a token scoped to the wrong
 * bucket apart from a wrong secret.
 */

import {
  GetBucketCorsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { buildPhotoKey, clientFor, createUploadUrl, readStorageConfig } from '../src/server/storage.ts';

const config = readStorageConfig();
if (!config) {
  console.error('\nR2 is not configured. .env.local needs R2_ACCOUNT_ID,');
  console.error('R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.\n');
  process.exit(1);
}

const client = clientFor(config);
console.log(`\nbucket:  ${config.bucket}`);
console.log(`account: ${config.accountId}\n`);

/** The error's NAME is the diagnosis; the message is noise. */
async function probe(label: string, run: () => Promise<unknown>) {
  try {
    const value = await run();
    console.log(`  ✓ ${label}`);
    return { ok: true as const, value };
  } catch (err) {
    // HeadBucket answers 403 with an empty body, so the SDK has no error
    // code to report and calls it "Unknown". The status still tells us.
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    const status = e.$metadata?.httpStatusCode;
    let name = e.name ?? String(err);
    if ((name === 'Unknown' || name === 'UnknownError') && status) {
      name = status === 403 ? 'AccessDenied (403, empty body)' : `HTTP ${status}`;
    }
    console.log(`  ✗ ${label} — ${name}`);
    return { ok: false as const, name };
  }
}

console.log('─── what can this token do? ───');

const list = await probe('list buckets', () => client.send(new ListBucketsCommand({})));
if (list.ok) {
  const names = ((list.value as { Buckets?: { Name?: string }[] }).Buckets ?? [])
    .map((b) => b.Name)
    .filter(Boolean);
  console.log(`      visible buckets: ${names.join(', ') || '(none)'}`);
  if (names.length > 0 && !names.includes(config.bucket)) {
    console.log(`      ⚠ ${config.bucket} is NOT among them — check R2_BUCKET for a typo,`);
    console.log('        or the token belongs to a different account.');
  }
}

const head = await probe(`see bucket ${config.bucket}`, () =>
  client.send(new HeadBucketCommand({ Bucket: config.bucket }))
);

// A missing object proves READ works: you only learn a key is absent if
// you were allowed to look. AccessDenied here means no read at all.
const get = await probe('read an object', () =>
  client.send(new GetObjectCommand({ Bucket: config.bucket, Key: 'r2-check-does-not-exist' }))
);
const canRead = get.ok || get.name === 'NoSuchKey';
if (!get.ok && get.name === 'NoSuchKey') console.log('      (NoSuchKey is the good answer — read works)');

const put = await probe('write an object', () =>
  client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: buildPhotoKey('anamma', '1970-01-01', 'image/jpeg'),
      Body: Buffer.from('r2-check'),
      ContentType: 'image/jpeg',
    })
  )
);

const cors = await probe('read bucket CORS settings', () =>
  client.send(new GetBucketCorsCommand({ Bucket: config.bucket }))
);
if (cors.ok) {
  const rules = (cors.value as { CORSRules?: Record<string, string[]>[] }).CORSRules ?? [];
  if (rules.length === 0) console.log('      ⚠ no CORS rules — a browser upload cannot work');
  for (const r of rules) {
    console.log(`      origins: ${(r.AllowedOrigins ?? []).join(', ')}`);
    console.log(`      methods: ${(r.AllowedMethods ?? []).join(', ')}`);
    console.log(`      headers: ${(r.AllowedHeaders ?? []).join(', ')}`);
    if ((r.AllowedOrigins ?? []).includes('*')) {
      console.log('      ⚠ "*" lets any site on the internet read these receipts');
    }
  }
}

// ── verdict ─────────────────────────────────────────────────────────────
console.log('\n─── verdict ───');
if (list.name === 'SignatureDoesNotMatch' || put.name === 'SignatureDoesNotMatch') {
  console.log('  The secret access key does not match the access key id.');
  console.log('  Cloudflare shows the secret once, at creation. Create a new');
  console.log('  R2 API token and replace both values in .env.local.');
} else if (list.name === 'InvalidAccessKeyId' || put.name === 'InvalidAccessKeyId') {
  console.log('  The access key id is not recognised — the token was deleted,');
  console.log('  or it belongs to a different Cloudflare account.');
} else if (put.ok) {
  console.log('  Writing works. If the app still fails, the browser is being');
  console.log('  blocked by CORS. docs/R2-CORS.md has the policy, and a');
  console.log('  hard-reload (Cmd+Shift+R) is needed — Chrome caches a failed');
  console.log('  preflight for an hour.');
} else if (canRead) {
  console.log('  The token can READ but not WRITE. It was created as');
  console.log('  "Object Read only". Create a new R2 API token with');
  console.log('  "Object Read & Write" and replace both values in .env.local.');
} else if (head.ok) {
  console.log('  The bucket is visible but neither read nor write is allowed,');
  console.log('  which is an odd combination — re-create the token as an R2');
  console.log('  API token with Object Read & Write scoped to this bucket.');
} else {
  console.log(`  The token cannot reach ${config.bucket} at all.`);
  console.log('  Most likely it is scoped to a DIFFERENT bucket. In Cloudflare,');
  console.log('  R2 > API > Manage API tokens, open the token and check whether');
  console.log('  it says "Apply to specific buckets only" with another bucket');
  console.log('  selected. Either scope it to this bucket or create a new one.');
  console.log('  Also confirm it is an R2 API token, not a User API token —');
  console.log('  only the R2 kind issues S3 credentials that work here.');
}
console.log('');
