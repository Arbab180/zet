import { NextResponse } from 'next/server';
import { getCurrentSession } from '../../../../server/currentSession';
import { authorizeRestaurantAccess } from '../../../../lib/authorize';
import { getRestaurantRole, withUserTransaction } from '../../../../lib/db';
import { keyBelongsTo, readObject, readStorageConfig } from '../../../../server/storage';
import { scanReceipt } from '../../../../server/scan';
import { parsePrintedCents } from '../../../../lib/money';

/**
 * Reads the amount off a receipt already uploaded to R2.
 *
 * Takes a KEY, never a URL. An endpoint that fetches whatever URL it is
 * handed is a server that can be pointed at anything reachable from
 * inside — other services, cloud metadata, a LAN address. Here the key
 * must match the exact shape buildPhotoKey produces, for the restaurant
 * and night this session was just authorised for, and it is read from our
 * own bucket. There is no way to name someone else's object, or anything
 * that is not an object.
 *
 * The result is a suggestion. It goes back with its own confidence and is
 * shown as editable; nothing here writes it to a report.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'not_authorised' }, { status: 401 });
  }

  const config = readStorageConfig();
  if (!config) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }

  let body: { restaurantId?: unknown; businessDate?: unknown; key?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const restaurantId = typeof body.restaurantId === 'string' ? body.restaurantId : '';
  const businessDate = typeof body.businessDate === 'string' ? body.businessDate : '';
  const key = typeof body.key === 'string' ? body.key : '';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const decision = await withUserTransaction(session.userId, (client) =>
    authorizeRestaurantAccess({
      session,
      restaurantId,
      minRole: 'write',
      getRole: (rid, uid) => getRestaurantRole(client, uid, rid),
    })
  );
  if (!decision.allowed) {
    return NextResponse.json({ error: 'not_authorised' }, { status: 403 });
  }

  // Checked AFTER authorisation, so a refusal cannot be used to probe which
  // keys exist for a restaurant someone has no access to.
  if (!keyBelongsTo(key, restaurantId, businessDate)) {
    return NextResponse.json({ error: 'bad_key' }, { status: 400 });
  }

  const bytes = await readObject(key, config);
  if (!bytes) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const mediaType = key.endsWith('.png')
    ? 'image/png'
    : key.endsWith('.webp')
      ? 'image/webp'
      : 'image/jpeg';

  const outcome = await scanReceipt(bytes, mediaType, parsePrintedCents);

  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.error, message: outcome.message },
      { status: outcome.error === 'not_configured' ? 503 : 502 }
    );
  }

  return NextResponse.json({ result: outcome.result });
}
