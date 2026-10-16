# The bucket needs a CORS rule before a browser can upload to it

## What goes wrong without it

Photos upload straight from the browser to R2 on a signed URL — the file
never passes through the app server, which is what keeps the R2 credential
off every till and a 200KB image off the app.

But that PUT is a **cross-origin request**: the page is on
`localhost:3000` (or your real domain later) and the upload goes to
`<account>.r2.cloudflarestorage.com`. A browser refuses that unless the
bucket says the origin is allowed.

The signed URL is perfectly valid. The server never sees a problem,
because the request never leaves the browser. In the app this appears as
"Ο αποθηκευτικός χώρος απέρριψε τη σύνδεση (CORS)", and in the browser
console as a CORS error on the PUT.

## The rule

Cloudflare dashboard → **R2** → your bucket → **Settings** → **CORS
Policy** → Add, then paste:

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:3000"
    ],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Add your real domain to `AllowedOrigins` when you deploy. Keep the list
explicit — `"*"` would let any website on the internet use a signed URL it
got hold of, and these are receipts showing suppliers and amounts.

`AllowedHeaders` must include `content-type` because the upload sends it,
and the signed URL is bound to that exact value.

It can take a minute to take effect. Hard-reload the page afterwards —
browsers cache a CORS failure.

## Checking it worked

Upload a receipt, then Cloudflare → R2 → your bucket. There should be
`receipts/<restaurant>/<date>/<uuid>.jpg`.

**Look at the file size.** It should be roughly 200KB. If it is 3–5MB the
browser-side compression did not run, and every estimate about the free
10GB is wrong by a factor of twenty.

## If it is still blocked with that policy in place

Almost certainly not the policy. Two causes, in the order they bite:

### The SDK signs a checksum header the policy does not allow

Since **@aws-sdk/client-s3 v3.729** the SDK adds a CRC32 checksum to
`PutObject` by default. On a presigned URL that checksum is part of the
signature, so the browser sends `x-amz-checksum-crc32` — and a policy
allowing only `content-type` refuses it. The signature is valid, the
policy looks right, and the upload is still blocked.

Fixed in `src/server/storage.ts` with `requestChecksumCalculation:
'WHEN_REQUIRED'` on the S3 client. Worth knowing because it will bite
again if that line is ever removed, or if the client is rebuilt elsewhere.

The alternative — adding `x-amz-*` to `AllowedHeaders` — also works, but
loosens the bucket to accommodate a default this code does not want.

### A different origin

`AllowedOrigins` matches exactly: scheme, host and port, no trailing
slash. Testing from a phone on the same Wi-Fi is a *different* origin
(`http://192.168.x.x:3000`) and needs its own entry. So does your real
domain, once deployed.

After any change, hard-reload (**⌘⇧R**). Browsers cache a CORS failure.

## When an upload fails, check the bucket name first

Run `npm run r2:check` before changing anything. It probes the credentials
from Node, where there is no browser and therefore no CORS, so it separates
causes that all surface in the app as the same single word.

The cheapest check is the one worth doing first: **does `R2_BUCKET` name a
bucket that actually exists?** R2 answers a request for a bucket you cannot
see and a bucket that does not exist with the same `403 AccessDenied`, and
it returns no CORS headers for either. So one wrong character in the bucket
name looks exactly like a missing CORS policy *and* exactly like a token
with no permissions, at the same time. It cost this project two wrong
diagnoses — a checksum header and a CORS policy that turned out to be
correct all along.

Reading the browser's error closely distinguishes the two cases:

- `Response to preflight request doesn't pass access control check: No
  'Access-Control-Allow-Origin' header...` — the **OPTIONS** was refused.
  Either there is no CORS policy, or the bucket is not there.
- `No 'Access-Control-Allow-Origin' header is present...` without that
  first clause — the preflight **passed**, so CORS is configured; the
  actual request failed for some other reason.

Expected output from a healthy Object Read & Write token:

```
  ✗ list buckets — AccessDenied          <- correct; it is bucket-scoped
  ✓ see bucket <name>
  ✗ read an object — NoSuchKey           <- correct; reading is permitted
  ✓ write an object
  ✗ read bucket CORS settings — AccessDenied   <- correct; Object scope
```

`AccessDenied` on the CORS read is not a failure. Widening the token to
Admin Read & Write would let the script read the policy, but that key sits
in a web app, and Admin lets it create and delete buckets. Check CORS from
the browser instead.

The script leaves a test object under `<restaurant>/1970-01-01/`. The
impossible date makes it easy to spot and delete.
