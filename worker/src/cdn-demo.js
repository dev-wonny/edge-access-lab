import { log } from "./logging.js";

// 버킷 전체를 공개하지 않고 기존 KR.png만 읽는다. 업로드/다운로드는 하지 않는다.
const OBJECT_KEY = "KR.png";

function failure(message, status) {
  return new Response(message, {
    status,
    headers: { "Cache-Control": "private, no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

function result(response, method, cacheStatus) {
  const headers = new Headers(response.headers);
  headers.set("X-Demo-Cache", cacheStatus);
  return new Response(method === "HEAD" ? null : response.body, {
    status: response.status,
    headers,
  });
}

export async function serveCdnDemo(request, env, resolveCache) {
  if (!["GET", "HEAD"].includes(request.method)) {
    const response = failure("Method not allowed", 405);
    response.headers.set("Allow", "GET, HEAD");
    return response;
  }

  const context = { requestId: crypto.randomUUID(), key: OBJECT_KEY };
  // 쿼리, 쿠키, JWT를 캐시 키에 포함하지 않는다. 모든 사용자가 같은 공개 이미지다.
  const url = new URL(request.url);
  url.search = "";
  const cacheKey = new Request(url.toString(), { method: "GET" });
  let cache;
  try {
    cache = resolveCache();
    const cached = await cache.match(cacheKey);
    log.info({ ...context, event: "cdn_cache_lookup", cacheStatus: cached ? "HIT" : "MISS" });
    if (cached) return result(cached, request.method, "HIT");
  } catch {
    cache = null;
    log.warn({ ...context, event: "cdn_cache_lookup_failed" });
  }

  let flag;
  try {
    flag = await env.FLAGS.get(OBJECT_KEY);
    log.info({ ...context, event: "cdn_r2_get", found: Boolean(flag) });
  } catch {
    log.error({ ...context, event: "cdn_r2_error" });
    return failure("Flag temporarily unavailable", 503);
  }
  if (!flag) return failure("Flag not available", 404);

  // 사용자 정보나 임의의 R2 메타데이터를 복사하지 않고 고정 헤더만 반환한다.
  const response = new Response(flag.body, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=60, s-maxage=300",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
  let cacheStatus = "BYPASS";
  if (cache) {
    try {
      // 작은 국기의 저장 완료를 기다려 다음 요청에서 HIT를 확인할 수 있게 한다.
      await cache.put(cacheKey, response.clone());
      cacheStatus = "MISS";
      log.info({ ...context, event: "cdn_cache_store" });
    } catch {
      log.warn({ ...context, event: "cdn_cache_store_failed" });
    }
  }
  return result(response, request.method, cacheStatus);
}
