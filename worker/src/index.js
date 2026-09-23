import { log } from "./logging.js";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Cloudflare Access의 공개키 조회 객체를 발급자별로 재사용한다.
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

// 공통 HTTP 응답을 만든다.
// 이미지 응답에 캐시 저장 금지를 붙이는 곳이 이 Worker의 respond() 함수
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

// 이메일에 HTML 특수문자가 있어도 코드로 실행되지 않도록 변환한다.
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

// 외부에서 받은 응답이 PNG인지 기본 검사를 한다.
// Content-Type, 최대 크기, PNG 시그니처를 확인한다.
// 이미지 전체를 디코딩하여 검사하는 것은 아니다.
async function readPng(response) {
  const type = response.headers
    .get("Content-Type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();

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

      // 256 KiB를 넘으면 저장하지 않는다.
      if (size > 256 * 1024) {
        return null;
      }

      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  // 나누어 읽은 데이터를 하나로 합친다.
  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // PNG 파일의 첫 8바이트를 확인한다.
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];

  return signature.every((byte, i) => bytes[i] === byte) ? bytes : null;
}

// 0. Access로 보호된 Worker에서는 Cache API를 사용할 수 없다
// 서버를 띄우고 요청을 받아 함수를 실행하는 일은 Cloudflare가 맡는 구조
// 테스트에서는 공개키 조회와 외부 다운로드 함수를 교체할 수 있다.
// 실제 배포에서는 remoteKeys와 기본 fetch를 사용한다.
export function createHandler(resolveKeys = remoteKeys, fetchFlag = fetch) {
  return {
    // Cloudflare가 HTTP 요청을 받으면 호출한다.
    // request: URL, 메서드, 헤더 등 요청 정보
    // env: Wrangler 환경변수와 R2 바인딩
    async fetch(request, env) {
      const { pathname } = new URL(request.url);

      const identityPage = pathname === "/secure" || pathname === "/secure/";

      // /secure/DE, /secure/US처럼 대문자 두 글자 경로를 받는다.
      const flagMatch = pathname.match(/^\/secure\/([A-Z]{2})$/);

      if (!identityPage && !flagMatch) {
        return respond("Not found", 404); // 그 외의 모든 경로는 404 반환
      }

      // GET 요청만 허용한다.
      if (request.method !== "GET") {
        const response = respond("Method not allowed", 405);
        response.headers.set("Allow", "GET");
        return response;
      }

      // 필요한 Access 설정이 없으면 처리할 수 없다.
      if (!env.TEAM_DOMAIN || !env.POLICY_AUD) {
        log.error({
          event: "access_config_missing",
          pathname,
        });

        return respond("Access configuration missing", 500);
      }

      // 바뀐 코드: 헤더가 없으면 쿠키에서 CF_Authorization을 꺼내옴
      // Cloudflare Access가 전달한 JWT를 읽는다 (헤더 우선, 브라우저 쿠키 지원).
      const cookieToken = request.headers
        .get("Cookie")
        ?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];

      // 기존 코드: 헤더만 확인하고, 쿠키는 열어보지 않음!
      const token =
        request.headers.get("Cf-Access-Jwt-Assertion") ||
        (cookieToken ? decodeURIComponent(cookieToken) : null);
      // token 결과: null
      log.info({ event: "access_token_checked", tokenPresent: Boolean(token) });

      //이제 브라우저에 쿠키만 심어두면 로컬에서도 401 에러 없이 화면이 정상적으로 열리게 됨
      if (!token) {
        log.warn({
          event: "authentication_missing",
          pathname,
        });

        return respond("Authentication required", 401);
      }

      let identity;

      // 1. Worker가 로그인 JWT를 검증
      try {
        // 서명, 발급자, 대상 앱, 만료 등을 검증한다.
        // exp, iat, email 필드는 반드시 존재해야 한다.
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

        // 이메일이 비어 있지 않은 문자열인지 확인한다.
        // 이메일 주소의 상세 문법까지 검사하는 코드는 아니다.
        // iat는 유효한 날짜로 변환 가능한 양의 정수여야 한다.
        if (
          typeof identity.email !== "string" ||
          !identity.email ||
          !Number.isSafeInteger(identity.iat) ||
          identity.iat <= 0 ||
          Number.isNaN(new Date(identity.iat * 1000).getTime())
        ) {
          log.warn({
            event: "invalid_identity",
            pathname,
          });

          return respond("Invalid identity", 403);
        }
      } catch {
        // JWT 원문이나 검증 오류의 상세 내용은 기록하지 않는다.
        log.warn({
          event: "authentication_failed",
          pathname,
        });

        return respond("Invalid or expired authentication", 403);
      }

      log.info({
        event: "authentication_verified",
        pathname,
      });

      // /secure에서는 인증된 사용자 정보를 HTML로 반환한다.
      if (identityPage) {
        // JWT 발급 시각이다.
        // 최초 IdP 로그인 시각과 반드시 같지는 않다.
        const timestamp = new Date(identity.iat * 1000).toISOString();

        // 검증한 JWT의 국가 정보를 우선 사용한다.
        // 없으면 Cloudflare가 파악한 현재 요청 국가를 사용한다.
        const detectedCountry = identity.country ?? request.cf?.country;

        const country =
          typeof detectedCountry === "string" &&
          /^[A-Z]{2}$/.test(detectedCountry)
            ? detectedCountry
            : "XX";

        log.info({
          event: "identity_page_returned",
          country,
          status: 200,
        });

        return respond(
          `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authenticated identity</title>
</head>
<body>
  <h1>Authenticated identity</h1>
  <p>${escapeHtml(identity.email)} authenticated at ${timestamp} from <a href="/secure/${country}">${country}</a></p>
</body>
</html>`,
          200,
          "text/html; charset=utf-8",
        );
      }

      // /secure/DE라면 country는 DE, key는 DE.png가 된다.
      const country = flagMatch[1];
      const key = `${country}.png`;

      // 예외가 발생한 단계를 로그에서 확인하기 위한 변수다.
      let stage = "r2_read";

      // 같은 요청의 로그를 묶어 찾기 위한 ID다.
      const requestId = crypto.randomUUID();

      const logContext = {
        requestId,
        country,
        key,
      };

      try {
        log.info({
          ...logContext,
          event: "flag_lookup_started",
          stage,
        });

        // 2. env.FLAGS.get("KR.png")로 R2에서 이미지를 읽음
        // Cloudflare가 연결해 준 R2 버킷에서 파일 읽기 : env.FLAGS.get(파일이름)
        // 먼저 비공개 R2 버킷에서 국기를 찾는다.
        let flag = await env.FLAGS.get(key);

        log.info({
          ...logContext,
          event: "flag_lookup_result",
          found: Boolean(flag),
        });

        if (!flag) {
          // XX는 국가를 알 수 없다는 표시이므로 다운로드하지 않는다.
          if (country === "XX") {
            return respond("Country not available", 404);
          }

          stage = "download";

          log.info({
            ...logContext,
            event: "flag_download_started",
            stage,
          });

          // 3. R2에 없으면 고정된 외부 주소에서 다운로드한다.
          // 사용자 쿠키나 JWT는 외부 서버에 전달하지 않는다.
          // 다운로드 제한 시간은 5초다.
          const source = await fetchFlag(
            `https://flagcdn.com/w640/${country.toLowerCase()}.png`,
            {
              headers: {
                Accept: "image/png",
              },
              redirect: "manual",
              signal: AbortSignal.timeout(5000),
            },
          );

          log.info({
            ...logContext,
            event: "flag_download_response",
            upstreamStatus: source.status,
            contentType: source.headers.get("Content-Type"),
          });

          if (!source.ok) {
            await source.body?.cancel();

            if (source.status === 404) {
              const hint =
                country === "UK"
                  ? " (영국 국기는 'UK' 대신 공식 코드인 'GB'를 사용해 주세요: /secure/GB)"
                  : "";
              log.warn({
                ...logContext,
                event: "flag_not_found",
                message: `해당 국가(${country})의 국기 이미지가 없습니다. 올바른 2자리 ISO 국가 코드(예: KR, US, GB, JP 등)로 요청해 주세요.${hint}`,
              });

              return respond(`Flag not available: ${country}${hint}`, 404);
            }

            log.error({
              ...logContext,
              event: "flag_upstream_error",
              upstreamStatus: source.status,
              message: `FlagCDN 서버 응답 오류 (HTTP ${source.status})`,
            });

            return respond("Flag source temporarily unavailable", 503);
          }

          // 다운로드한 파일의 타입·크기·시그니처를 검사한다.
          stage = "validate_png";
          const bytes = await readPng(source);

          if (!bytes) {
            log.warn({
              ...logContext,
              event: "flag_image_invalid",
              stage,
            });

            return respond("Invalid flag image from source", 502);
          }

          log.info({
            ...logContext,
            event: "flag_image_validated",
            sizeBytes: bytes.byteLength,
          });

          // 검사한 PNG를 R2에 저장한다.
          stage = "r2_write";

          await env.FLAGS.put(key, bytes, {
            httpMetadata: {
              contentType: "image/png",
            },
          });

          log.info({
            ...logContext,
            event: "flag_saved",
            stage,
          });

          // 첫 요청도 R2에 저장한 뒤 다시 읽어서 반환한다.
          stage = "r2_read_after_write";
          flag = await env.FLAGS.get(key);

          if (!flag) {
            log.error({
              ...logContext,
              event: "flag_missing_after_write",
              stage,
            });

            return respond("Flag storage temporarily unavailable", 503);
          }
        }

        log.info({
          ...logContext,
          event: "flag_returned",
          status: 200,
        });

        // 4. 이미지를 반환하면서 캐시 저장 금지 헤더를 붙임 -> 다음 요청에도 Worker는 R2를 다시 읽음
        return respond(flag.body, 200, "image/png");
      } catch (error) {
        // 어느 단계에서 어떤 예외가 발생했는지 기록한다.
        // 요청 헤더, JWT, 쿠키는 기록하지 않는다.
        log.error({
          ...logContext,
          event: "flag_error",
          stage,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage:
            error instanceof Error ? error.message : "Unknown error",
        });

        // 브라우저에는 내부 오류 정보를 노출하지 않는다.
        return respond("Flag temporarily unavailable", 503);
      }
    },
  };
}

// Cloudflare가 사용할 요청 처리 객체를 기본 내보내기로 제공한다.
export default createHandler();
