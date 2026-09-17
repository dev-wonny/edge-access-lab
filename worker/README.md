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

Tests use generated RSA keys, locally signed JWTs and a fake R2 binding.
They do not authenticate with the live IdP or read the live bucket.
The dry run builds the Worker without deploying it.

## Flags and deployment

Keep R2 bucket `edge-access-lab-flags` private: do not enable r2.dev or a public
custom domain. Upload real PNG flag assets with uppercase keys, for example:

```sh
npx wrangler r2 object put edge-access-lab-flags/KR.png --file ./flags/KR.png --content-type image/png --remote
npm run deploy
```

Flag assets are not included yet. Provide PNG files for countries demonstrated;
missing country assets (including unknown country `XX`) produce a clear 404.
Additional countries use the same two-letter uppercase convention.
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

## References

- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- https://developers.cloudflare.com/workers/wrangler/configuration/
