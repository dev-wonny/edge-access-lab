import { createRemoteJWKSet, jwtVerify } from 'jose';

const keySets = new Map();
function remoteKeys(issuer) {
  if (!keySets.has(issuer)) {
    keySets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));
  }
  return keySets.get(issuer);
}

function respond(body, status = 200, type = 'text/plain; charset=utf-8') {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': type,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, char => entities[char]);
}

// Tests supply a local public-key resolver; deployed requests always use Access JWKS.
export function createHandler(resolveKeys = remoteKeys) {
  return {
    async fetch(request, env) {
      const { pathname } = new URL(request.url);
      const identityPage = pathname === '/secure' || pathname === '/secure/';
      const flagMatch = pathname.match(/^\/secure\/([A-Z]{2})$/);
      if (!identityPage && !flagMatch) return respond('Not found', 404);
      if (request.method !== 'GET') {
        const response = respond('Method not allowed', 405);
        response.headers.set('Allow', 'GET');
        return response;
      }
      if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return respond('Access configuration missing', 500);
      const token = request.headers.get('Cf-Access-Jwt-Assertion');
      if (!token) return respond('Authentication required', 401);
      let identity;
      try {
        const { payload } = await jwtVerify(token, resolveKeys(env.TEAM_DOMAIN), {
          issuer: env.TEAM_DOMAIN,
          audience: env.POLICY_AUD,
          algorithms: ['RS256'],
          requiredClaims: ['exp', 'iat', 'email'],
        });
        identity = payload;
        if (typeof identity.email !== 'string' || !identity.email ||
            !Number.isSafeInteger(identity.iat) || identity.iat <= 0 ||
            Number.isNaN(new Date(identity.iat * 1000).getTime())) {
          return respond('Invalid identity', 403);
        }
      } catch {
        // Never echo tokens or verification error details.
        return respond('Invalid or expired authentication', 403);
      }
      if (identityPage) {
        // Session token issue time, not necessarily the original IdP login time.
        const timestamp = new Date(identity.iat * 1000).toISOString();
        const detectedCountry = identity.country ?? request.cf?.country;
        const country = typeof detectedCountry === 'string' && /^[A-Z]{2}$/.test(detectedCountry)
          ? detectedCountry : 'XX';
        return respond(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authenticated identity</title></head>
<body><h1>Authenticated identity</h1><p>${escapeHtml(identity.email)} authenticated at ${timestamp} from <a href="/secure/${country}">${country}</a></p></body>
</html>`, 200, 'text/html; charset=utf-8');
      }
      try {
        const flag = await env.FLAGS.get(`${flagMatch[1]}.png`);
        if (!flag) return respond(`Flag not available: ${flagMatch[1]}`, 404);
        return respond(flag.body, 200, 'image/png');
      } catch {
        return respond('Flag storage temporarily unavailable', 503);
      }
    },
  };
}

export default createHandler();
