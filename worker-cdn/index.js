/*
## curl
curl -sS -D - -o /dev/null https://tunnel.devwonny.win/cdn/KR.png

## curl 첫번째 결과
HTTP/2 200 
date: Sun, 27 Sep 2026 00:02:40 GMT
content-type: image/png
content-length: 2456
cache-control: public, max-age=300
x-content-type-options: nosniff
x-demo-cache: MISS
report-to: {"group":"cf-nel","max_age":604800,"endpoints":[{"url":"https://a.nel.cloudflare.com/report/v4?s=tNgUo92WtJrFPf4zR5X4oAEpqJi73iVDFFFIabXkEY26%2BFEkgawrt9%2BifCu27aziNlaiPqRwKswu%2FqDw0DF9Iu9eJF4e0tpUTqnpcg2hgljUDRpUvFtyfhc%2FZBAUHLY%2FJr7eT45R"}]}
nel: {"report_to":"cf-nel","success_fraction":0.0,"max_age":604800}
server: cloudflare
cf-ray: a4163da55c3906b9-HKG
alt-svc: h3=":443"; ma=86400


## curl 두번째 결과
HTTP/2 200 
date: Sun, 27 Sep 2026 00:03:37 GMT
content-type: image/png
content-length: 2456
cf-ray: a4163f102b1461ec-HKG
cf-cache-status: HIT
accept-ranges: bytes
age: 57
cache-control: public, max-age=14400
last-modified: Sun, 27 Sep 2026 00:02:40 GMT
server: cloudflare
x-content-type-options: nosniff
x-demo-cache: HIT
report-to: {"group":"cf-nel","max_age":604800,"endpoints":[{"url":"https://a.nel.cloudflare.com/report/v4?s=dqECvXSvvb4jMpkcBa%2FpWfbkLGAc%2BWfcfGUcqsd%2B%2BjDVoWhB5d%2FRudLX%2FpIOGBBnoebvnS9JPcjsGza9Z4k3hUB3YXsOpmMLJhdnxFbXeljeQzVdF1JHWIyac%2FYWq6IF5XW5lRLX"}]}
nel: {"report_to":"cf-nel","success_fraction":0.0,"max_age":604800}
alt-svc: h3=":443"; ma=86400


| 항목 | 첫 번째 | 두 번째 | 의미 |
|---|---|---|---|
| 시각 | 00:02:40 | 00:03:37 | 57초 간격 |
| 처리 위치 | HKG | HKG | 둘 다 홍콩 |
| `x-demo-cache` | MISS | HIT | Worker의 캐시 조회 결과 |
| `age` | 없음 | 57 | 캐시된 응답의 나이 |
| `max-age` | 300초 | 14400초 | 클라이언트에 전달된 캐시 정책이 바뀜 |


 */
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

// 이 코드는 Cloudflare 서버에서 실행됩니다.
// Worker는 개발자가 캐시 조회·저장을 직접 작성함
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

    // ① 사용할 기본 캐시를 선택
    const cache = caches.default;
    let cacheStatus = "MISS";

    // 1. Cloudflare 캐시에서 먼저 찾는다.
    try {
      // ② cacheKey로 Cloudflare 캐시에 저장된 응답이 있는지 조회
      const cached = await cache.match(cacheKey);

      // ③ 있으면 그대로 반환
      if (cached) {
        const response = new Response(cached.body, cached);

        // 디버깅을 위한 커스텀 헤더
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
      // ④ 없으면 R2 원본 읽기
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

    // ⑤ 이미지 응답 만들기
    const response = new Response(object.body, {
      // 브라우저는 "Cache-Control" 헤더를 보고 “이 응답을 저장하고, 신선한 동안 재사용할 수 있겠구나”라고 판단
      /**
       * [브라우저의 캐시 흐름]
       * 1. 처음 이미지 보기
       *    -> 네트워크에서 다운로드
       *    -> 브라우저가 저장
       *
       * 2. 잠시 뒤 같은 이미지 다시 사용
       *    -> 브라우저에 재사용 가능한 복사본이 있으면 사용
       *    -> 네트워크 요청 자체가 생략될 수 있음
       */
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": `public, max-age=${TTL_SECONDS}`, //300초 동안 캐시하도록 응답 생성
        "X-Content-Type-Options": "nosniff",
      },
    });

    // 3. 다음 요청에서 재사용하도록 캐시에 저장한다.
    try {
      // ⑥ 응답 복사본을 Cloudflare 캐시에 저장
      await cache.put(cacheKey, response.clone());
    } catch {
      cacheStatus = "ERROR";
      console.warn("flag_cache_write_failed");
    }

    // MISS: 캐시에서 찾지 못함. ERROR: 캐시 작업 중 오류 발생.
    response.headers.set("X-Demo-Cache", cacheStatus);

    // ⑦ 사용자에게 반환
    return response;
  },
};
