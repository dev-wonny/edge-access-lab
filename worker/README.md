# Authenticated identity Worker

Handles `/secure` and `/secure/XX` on `tunnel.devwonny.win`.
Cloudflare Access must protect both `/secure` and `/secure/*` with the existing
self-email OR @cloudflare.com policy. The Worker verifies RS256 signatures,
issuer, audience, expiry and required identity claims before returning content.
It never returns or logs the bearer token or login cookie.

## Setup and checks

Run from this directory:

```sh
npm ci
npm run types
npm test
npm run check
```

Tests use generated RSA keys, locally signed JWTs, a fake R2 binding and a
mock flag downloader. They do not authenticate with the live IdP, call the
flag CDN or read the live bucket.
The dry run builds the Worker without deploying it.

## Flags and deployment

Keep R2 bucket `edge-access-lab-flags` private: do not enable r2.dev or a public
custom domain. Deploy using Wrangler:

```sh
npm run deploy
```

No bulk flag upload is required. After Access JWT verification, `/secure/US`:

1. Reads `US.png` from the private R2 bucket.
2. If absent, downloads `https://flagcdn.com/w640/us.png` with a five-second
   timeout. The outgoing request contains no user cookies or Access tokens.
3. Checks the PNG content type, signature and 256 KiB size limit, then stores
   `US.png` with `Content-Type: image/png`.
4. Reads the stored object from R2 and returns it. Subsequent requests use R2
   without downloading again; existing flags are not refreshed automatically.

The country path accepts only two uppercase letters and the download host is
fixed. Redirects are rejected. Unknown country `XX` and source 404s return 404;
source/network/storage failures return 503; invalid image responses return 502.
Failures are not stored, so a later request can retry. Concurrent first requests
can download and write the same flag more than once.

Flags come from [Flagpedia / FlagCDN](https://flagpedia.net/download/images),
which provides the source images as public domain. The included `flags/KR.png`
can still be uploaded or replaced explicitly with Wrangler:

```sh
npx wrangler r2 object put edge-access-lab-flags/KR.png --file ./flags/KR.png --content-type image/png --remote
```

No browser-facing R2 credentials are needed: the Worker accesses R2 through FLAGS.

`TIMESTAMP` is the verified Access application's JWT `iat` (UTC), not necessarily
the first Google/IdP sign-in time. Country uses the verified token country first,
then request.cf.country. Country is a location estimate, not nationality.

This route responds at the Cloudflare edge; it does not send these requests
through cloudflared. Existing /headers traffic continues through the Tunnel.
The broad Worker route /secure* is narrowed by the handler: /secure-other is 404.
workers.dev and version preview URLs are disabled.

After deploying, check anonymous /headers is 200, anonymous /secure and
/secure/KR redirect to Access, permitted login shows HTML and PNG, and an
unapproved account is denied. Local tests do not replace these live checks.
To check automatic storage, open `/secure/US` while logged in with a permitted
account, then confirm that `US.png` appears in R2. Open it again to exercise the
existing-object path. Use another supported country if `US.png` already exists.

## References

- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- https://developers.cloudflare.com/workers/wrangler/configuration/
