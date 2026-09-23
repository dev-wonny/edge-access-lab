const TTL_SECONDS = 300;

function errorResponse(message, status, extraHeaders = {}) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 공개할 이미지는 KR.png 한 장으로 제한한다.
    if (url.pathname !== "/cdn/KR.png") {
      return errorResponse("Not found", 404);
    }

    if (request.method !== "GET") {
      return errorResponse("Method not allowed", 405, {
        Allow: "GET",
      });
    }

    if (!env.FLAGS) {
      return errorResponse("R2 binding FLAGS is missing", 503);
    }

    // 같은 이미지를 공유한다. 쿠키·JWT는 캐시 키에 포함하지 않는다.
    const cacheKey = new Request(new URL("/cdn/KR.png", url.origin));

    const cache = caches.default;
    let cacheStatus = "MISS";

    // 1. Cloudflare 캐시에서 먼저 찾는다.
    try {
      const cached = await cache.match(cacheKey);

      if (cached) {
        const response = new Response(cached.body, cached);
        response.headers.set("X-Demo-Cache", "HIT");
        return response;
      }
    } catch {
      cacheStatus = "ERROR";
      console.warn("flag_cache_read_failed");
    }

    // 2. 캐시에 없으면 R2에서 읽는다.
    let object;

    try {
      object = await env.FLAGS.get("KR.png");
    } catch {
      return errorResponse("R2 temporarily unavailable", 503);
    }

    if (!object) {
      return errorResponse(
        "KR.png is missing from the selected R2 bucket",
        404,
      );
    }

    const response = new Response(object.body, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": `public, max-age=${TTL_SECONDS}`,
        "X-Content-Type-Options": "nosniff",
      },
    });

    // 3. 다음 요청에서 재사용하도록 캐시에 저장한다.
    try {
      await cache.put(cacheKey, response.clone());
    } catch {
      cacheStatus = "ERROR";
      console.warn("flag_cache_write_failed");
    }

    // MISS: 캐시에서 찾지 못함. ERROR: 캐시 작업 중 오류 발생.
    response.headers.set("X-Demo-Cache", cacheStatus);
    return response;
  },
};
