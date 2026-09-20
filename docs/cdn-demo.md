# 기존 R2 국기로 CDN 캐시 확인하기

새 이미지를 EC2나 R2에 업로드하지 않는다. `edge-access-lab-flags` 버킷의 기존 `KR.png`를 Worker의 `/cdn-demo/KR.png`에서 공개하고 Cache API로 재사용한다. R2 버킷 자체는 비공개다.

| 경로 | 인증 | 저장소/캐시 |
| --- | --- | --- |
| `/secure/KR` | 기존 Access 인증 유지 | R2, 응답 `private, no-store` |
| `/cdn-demo/KR.png` | 공개 | Cache API HIT이면 바로 반환, MISS이면 기존 R2 객체 조회 |
| `/cdn-demo/DE.png` 등 | 공개 대상 아님 | 404, R2 조회 없음 |

공개 경로는 `KR.png` 한 개만 허용한다. R2에 없으면 캐시하지 않는 404를 반환하며 외부 다운로드나 R2 쓰기는 하지 않는다. 쿠키·JWT·쿼리는 캐시 키에 포함하지 않고, 사용자별 정보도 응답에 넣지 않는다. GET과 HEAD만 허용한다.

## GitHub에서 배포

PR을 main에 병합하면 기존 Cloudflare Builds가 worker 테스트와 배포를 실행한다. `worker/wrangler.jsonc`에 추가한 `tunnel.devwonny.win/cdn-demo/*` Route도 배포된다. 이 변경에는 Python, Nginx, EC2 설정 변경이 없다.

Access의 기존 보호 범위 `/secure`, `/secure/*`는 유지한다. 공개 데모 경로까지 Access로 보호하면 Cache API 동작을 기대할 수 없다. 다른 전역 Access 정책이 있다면 실제 공개 경로에 적용되는지 확인한다.

## 실제 배포 후 확인

아래 명령을 두 번 실행한다. 브라우저 자체 캐시를 피하기 위해 curl을 사용한다.

```bash
curl -sS -D - -o /dev/null 'https://tunnel.devwonny.win/cdn-demo/KR.png'
curl -sS -D - -o /dev/null 'https://tunnel.devwonny.win/cdn-demo/KR.png'
```

- `X-Demo-Cache: MISS`: 조회 시 캐시가 없어 R2를 읽고 캐시 저장을 시도했다.
- `X-Demo-Cache: HIT`: Cache API에서 이미지를 읽었다. 해당 요청은 R2를 읽지 않는다.
- `X-Demo-Cache: BYPASS`: 캐시 조회/저장 중 예외가 발생했지만 R2 이미지로 응답했다.
- `Cache-Control: public, max-age=60, s-maxage=300`: 브라우저 60초, 공유 캐시 300초 정책이다.

`X-Demo-Cache`는 이 코드에서 설정한 진단 헤더다. `CF-Cache-Status`로 이 코드의 Cache API HIT 여부를 판정하지 않는다. 저장 호출이 완료되어도 실제 저장을 보장하지 않으므로 다음 요청의 HIT로 확인한다. 캐시는 데이터센터별이며 만료·퇴거·다른 데이터센터 도착 시 다시 MISS가 날 수 있다. 쿼리 변경은 이 데모의 캐시를 비우지 않는다. R2 객체를 바꿨다면 기존 캐시 TTL이 지난 후 확인한다.

## 로그로 확인

Workers Observability에서 `cdn_cache_lookup`의 HIT/MISS를 확인한다. MISS에는 `cdn_r2_get`, 저장 시도 완료에는 `cdn_cache_store`가 기록된다. `requestId`로 한 요청을 묶는다. HIT에도 Worker는 실행되지만 R2 조회는 건너뛴다. 이 경로는 EC2로 가지 않으므로 Nginx/CloudWatch에 요청 로그가 없는 것이 정상이다.

## 검증 범위

`cd worker && npm test`로 MISS→HIT, R2 조회 횟수, GET/HEAD, 공개 객체 제한, 오류 비캐싱, 캐시 장애 우회, 기존 인증 정책을 검증한다. 테스트 캐시는 모의 구현이므로 Cloudflare 실제 HIT 확인은 병합·배포 후 위 명령으로 진행한다.

참고: [Cloudflare Cache API 문서](https://developers.cloudflare.com/workers/runtime-apis/cache/) — 데이터센터별 캐시, Access 제약, cache.put 반환 동작.
