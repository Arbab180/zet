/**
 * Receipt photo storage, on Cloudflare R2.
 *
 * R2 speaks the S3 API, so this uses @aws-sdk/client-s3 with R2's endpoint.
 * Nothing here is AWS-specific beyond the protocol; moving to another
 * S3-compatible store later is a change of endpoint and credentials.
 *
 * ── The browser never gets a credential ─────────────────────────────────
 *
 * Uploads do not pass through this server. The browser asks for a
 * short-lived signed URL, PUTs the file straight to R2, and tells us the
 * key. That keeps a 200KB photo off the app server entirely, and — the
 * part that matters — means the R2 access key exists only in the server's
 * environment. A public bucket or a client-side credential would put every
 * restaurant's receipts, with supplier names and amounts, one URL guess
 * away.
 *
 * Reads are signed the same way and expire, so a URL that leaks in a chat
 * log or a browser history stops working.
 *
 * ── Keys are derived, never accepted ────────────────────────────────────
 *
 * The caller says which restaurant and night a photo belongs to; this
 * builds the key. If the browser chose the key it could write over another
 * restaurant's receipt, or read one, by naming it.
 *
 * Unconfigured means unavailable, not "fall back to something". Without
 * R2_* set, isStorageConfigured() is false and the UI says photos are not
 * set up rather than appearing to work and losing the file.
 */

import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface StorageConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function readStorageConfig(
  env: Record<string, string | undefined> = process.env
): StorageConfig | null {
  const accountId = env.R2_ACCOUNT_ID ?? '';
  const accessKeyId = env.R2_ACCESS_KEY_ID ?? '';
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY ?? '';
  const bucket = env.R2_BUCKET ?? '';
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export function isStorageConfigured(): boolean {
  return readStorageConfig() !== null;
}

let cached: { config: StorageConfig; client: S3Client } | null = null;

/** Exported for scripts/r2-check.ts, which diagnoses upload failures. */
export function clientFor(config: StorageConfig): S3Client {
  if (cached && cached.config.bucket === config.bucket) return cached.client;
  const client = new S3Client({
    region: 'auto', // R2 has no regions; the SDK insists on a value
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    /**
     * Without this, a browser upload to R2 is blocked before it leaves.
     *
     * Since v3.729 the SDK adds a CRC32 checksum to PutObject by default.
     * For a PRESIGNED url that checksum is signed into the request, so the
     * browser must send `x-amz-checksum-crc32` — and a bucket CORS policy
     * that allows only `content-type` refuses it. The failure surfaces as
     * a CORS error with a valid signature and a correct-looking policy,
     * which is a genuinely confusing place to end up.
     *
     * WHEN_REQUIRED sends a checksum only where the API demands one, which
     * PutObject does not. The alternative — widening AllowedHeaders to
     * cover x-amz-* — would loosen the bucket to work around a default
     * this code does not want in the first place.
     */
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  cached = { config, client };
  return client;
}

/** Longer than a slow upload on a bad connection, shorter than a coffee break. */
const UPLOAD_URL_TTL_SECONDS = 300;
/** Long enough to render a page, short enough that a leaked link dies. */
const READ_URL_TTL_SECONDS = 300;

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedPhotoType = (typeof ALLOWED_PHOTO_TYPES)[number];

export function isAllowedPhotoType(t: string): t is AllowedPhotoType {
  return (ALLOWED_PHOTO_TYPES as readonly string[]).includes(t);
}

/**
 * receipts/<restaurant>/<business-date>/<uuid>.<ext>
 *
 * Restaurant and date come from the server's own authorisation check, and
 * the uuid means two people photographing at once cannot collide. Nothing
 * the browser sent appears in the key — not even the original filename,
 * which is attacker-controlled text.
 */
export function buildPhotoKey(
  restaurantId: string,
  businessDate: string,
  contentType: AllowedPhotoType
): string {
  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  return `receipts/${restaurantId}/${businessDate}/${randomUUID()}.${ext}`;
}

/** The key must look exactly like one buildPhotoKey made, for this night. */
export function keyBelongsTo(key: string, restaurantId: string, businessDate: string): boolean {
  const pattern = new RegExp(
    `^receipts/${escapeRe(restaurantId)}/${escapeRe(businessDate)}/` +
      `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|png|webp)$`
  );
  return pattern.test(key);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function createUploadUrl(
  key: string,
  contentType: AllowedPhotoType,
  config: StorageConfig
): Promise<string> {
  return getSignedUrl(
    clientFor(config),
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS }
  );
}

export async function createReadUrl(key: string, config: StorageConfig): Promise<string> {
  return getSignedUrl(
    clientFor(config),
    new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    { expiresIn: READ_URL_TTL_SECONDS }
  );
}

/** Fetches an object's bytes server-side, for the scanner. */
export async function readObject(key: string, config: StorageConfig): Promise<Buffer | null> {
  try {
    const result = await clientFor(config).send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key })
    );
    if (!result.Body) return null;
    const bytes = await result.Body.transformToByteArray();
    return Buffer.from(bytes);
  } catch {
    return null;
  }
}
