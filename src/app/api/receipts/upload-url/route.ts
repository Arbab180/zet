import { NextResponse } from 'next/server';
import { getCurrentSession } from '../../../../server/currentSession';
import { authorizeRestaurantAccess } from '../../../../lib/authorize';
import { getRestaurantRole, withUserTransaction } from '../../../../lib/db';
import {
  buildPhotoKey,
  createUploadUrl,
  isAllowedPhotoType,
  readStorageConfig,
} from '../../../../server/storage';

/**
 * Hands back a short-lived URL the browser can PUT one photo to.
 *
 * Why the browser uploads directly rather than posting the file here: a
 * photo never touches this server, and — the part that matters — the R2
 * credential stays in the server environment instead of being shipped to
 * every till.
 *
 * What this refuses, and why each one matters:
 *
 *  - no session, or no write access to THIS restaurant. Without it, anyone
 *    signed in could write into any restaurant's folder.
 *  - a content type that is not one of three image types. The signed URL
 *    pins the type, so R2 rejects a mismatched upload too.
 *  - a key chosen by the caller. There is no way to supply one: the key is
 *    built here from the restaurant and date the check above authorised.
 *    A caller-chosen key is a caller-chosen destination.
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

  let body: { restaurantId?: unknown; businessDate?: unknown; contentType?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const restaurantId = typeof body.restaurantId === 'string' ? body.restaurantId : '';
  const businessDate = typeof body.businessDate === 'string' ? body.businessDate : '';
  const contentType = typeof body.contentType === 'string' ? body.contentType : '';

  // The date becomes part of the object key, so it is pinned to a shape
  // rather than trusted: anything else could walk the key out of its folder.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  if (!isAllowedPhotoType(contentType)) {
    return NextResponse.json({ error: 'bad_type' }, { status: 400 });
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

  const key = buildPhotoKey(restaurantId, businessDate, contentType);
  const url = await createUploadUrl(key, contentType, config);

  return NextResponse.json({ key, url });
}
