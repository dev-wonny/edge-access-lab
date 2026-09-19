import { createRemoteJWKSet, jwtVerify } from "jose";

const keySets = new Map();
function remoteKeys(issuer) {
  if (!keySets.has(issuer)) {
    keySets.set(
      issuer,
      createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
    );
  }
  return keySets.get(issuer);
}

function respond(body, status = 200, type = "text/plain; charset=utf-8") {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": type,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function escapeHtml(value) {
  const entities = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return String(value).replace(/[&<>"']/g, (char) => entities[char]);
}

// 외부 서버의 오류 페이지나 과도하게 큰 응답을 R2에 저장하지 않는다.
async function readPng(response) {
  const type = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (type !== "image/png" || !response.body) {
    await response.body?.cancel();
    return null;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return signature.every((byte, i) => bytes[i] === byte) ? bytes : null;
}

// 네 코드는 “요청이 오면 무엇을 할지”를 작성했음
// 서버를 띄우고 요청을 받아 함수를 실행하는 일은 Cloudflare가 맡는 구조
// Tests supply a local public-key resolver; deployed requests always use Access JWKS.
export function createHandler(resolveKeys = remoteKeys, fetchFlag = fetch) {
  return {
    // fetch는 Cloudflare가 HTTP 요청을 받았을 때 호출하는 함수
    // 요청을 받아 처리하는 컨트롤러 역할
    // request : 사용자가 보낸 URL, 메서드, 헤더 등
    // env : 설정한 환경변수와 R2 연결
    async fetch(request, env) {
      const { pathname } = new URL(request.url);
      const identityPage = pathname === "/secure" || pathname === "/secure/";
      // 국가명
      const flagMatch = pathname.match(/^\/secure\/([A-Z]{2})$/);
      if (!identityPage && !flagMatch) return respond("Not found", 404);

      // get 요청이 아니면 405 에러 리턴
      if (request.method !== "GET") {
        const response = respond("Method not allowed", 405);
        response.headers.set("Allow", "GET");
        return response;
      }

      // 설정과 규칙이 다르면 500 에러 리턴
      if (!env.TEAM_DOMAIN || !env.POLICY_AUD)
        return respond("Access configuration missing", 500);

      // 헤더에서 토큰 꺼냄
      const token = request.headers.get("Cf-Access-Jwt-Assertion");

      // 토큰 없으면 401 에러 리턴
      if (!token) return respond("Authentication required", 401);

      // 토큰 검증
      let identity;
      // 토큰 검증 ( issuer, audience, exp, iat, email )
      try {
        const { payload } = await jwtVerify(
          token,
          resolveKeys(env.TEAM_DOMAIN),
          {
            issuer: env.TEAM_DOMAIN,
            audience: env.POLICY_AUD,
            algorithms: ["RS256"],
            requiredClaims: ["exp", "iat", "email"],
          },
        );
        identity = payload;

        // 토큰 검증 : 이메일형식, 빈값이아닌지, iat가 유효한지, 날짜형식이 맞는지
        // 검증 통과 못하면 403 에러 리턴
        if (
          typeof identity.email !== "string" ||
          !identity.email ||
          !Number.isSafeInteger(identity.iat) ||
          identity.iat <= 0 ||
          Number.isNaN(new Date(identity.iat * 1000).getTime())
        ) {
          return respond("Invalid identity", 403);
        }
      } catch {
        // Never echo tokens or verification error details.
        return respond("Invalid or expired authentication", 403);
      }

      // 경로가 secure 이면
      if (identityPage) {
        // Session token issue time, not necessarily the original IdP login time.
        const timestamp = new Date(identity.iat * 1000).toISOString();
        // 국가 추출
        const detectedCountry = identity.country ?? request.cf?.country; // Cloudflare가 파악한 요청 국가
        const country =
          typeof detectedCountry === "string" &&
          /^[A-Z]{2}$/.test(detectedCountry)
            ? detectedCountry
            : "XX";
        return respond(
          `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authenticated identity</title></head>
<body><h1>Authenticated identity</h1><p>${escapeHtml(identity.email)} authenticated at ${timestamp} from <a href="/secure/${country}">${country}</a></p></body>
</html>`,
          200,
          "text/html; charset=utf-8",
        );
      }
      try {
        // Cloudflare가 연결해 준 R2 버킷에서 파일 읽기 : env.FLAGS.get(파일이름)
        const country = flagMatch[1];
        const key = `${country}.png`;
        let flag = await env.FLAGS.get(key);
        if (!flag) {
          if (country === "XX") return respond("Country not available", 404);

          // 인증 후에만 고정된 출처에 요청한다. 사용자 쿠키/JWT는 전달하지 않는다.
          const source = await fetchFlag(
            `https://flagcdn.com/w640/${country.toLowerCase()}.png`,
            {
              headers: { Accept: "image/png" },
              redirect: "error",
              signal: AbortSignal.timeout(5000),
            },
          );
          if (!source.ok) {
            await source.body?.cancel();
            return source.status === 404
              ? respond(`Flag not available: ${country}`, 404)
              : respond("Flag source temporarily unavailable", 503);
          }
          const bytes = await readPng(source);
          if (!bytes) return respond("Invalid flag image from source", 502);

          await env.FLAGS.put(key, bytes, {
            httpMetadata: { contentType: "image/png" },
          });
          // 첫 요청도 저장 완료 후 private R2에서 읽은 파일로 응답한다.
          flag = await env.FLAGS.get(key);
          if (!flag) return respond("Flag storage temporarily unavailable", 503);
        }
        return respond(flag.body, 200, "image/png");
      } catch {
        return respond("Flag temporarily unavailable", 503);
      }
    },
  };
}
// 그 함수를 Cloudflare에 내보내기
export default createHandler();
