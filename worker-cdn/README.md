# 공개 국기 CDN 데모 배포

`https://infiniteloopclub.cloud/cdn/KR.png`는 `flag-cdn-demo` Worker가 비공개 R2 버킷 `edge-access-lab-flags`의 `KR.png`를 읽어 응답하는 주소다. 기존 `https://tunnel.devwonny.win/cdn/KR.png`도 유지한다. 삭제한 `tunnel.infiniteloopclub.cloud`는 사용하지 않는다.

## 요청 흐름

1. Cloudflare의 Proxied DNS 호스트로 요청한다.
2. `wrangler.jsonc`의 `/cdn/*` Route가 이 Worker를 실행한다.
3. Cache API에 이미지가 있으면 반환하고, 없으면 R2의 `KR.png`를 읽어 저장을 시도한다.

EC2, Tunnel, Nginx를 거치지 않는다. `/cdn/`용 Nginx 설정이나 EC2 파일 복사가 필요 없다. 버킷의 공개 접근을 켤 필요도 없다. Worker가 공개하는 객체는 `KR.png` 하나이며 다른 경로는 404다. 기존 `/secure`의 Access 보호는 별도 Worker에서 유지한다.

이 Worker는 `worker/`의 `edge-access-lab` Worker 및 `/cdn-demo/*` 데모와 별도다. `worker/`만 배포하면 여기의 Route는 반영되지 않는다.

## Mac에서 배포

PR 병합 후 로컬 저장소 루트에서 실행한다. 작업 중인 변경이 있다면 먼저 별도 커밋으로 보관한다.

```bash
git switch main
git pull --ff-only origin main

# 저장소에서 고정한 Wrangler 버전과 의존성을 설치한다.
npm ci --prefix worker

# 배포 대상 이름이 flag-cdn-demo인지 출력에서 확인한다.
./worker/node_modules/.bin/wrangler deploy --config worker-cdn/wrangler.jsonc --dry-run
./worker/node_modules/.bin/wrangler deploy --config worker-cdn/wrangler.jsonc
```

처음 사용하는 Mac이라면 배포 전 `./worker/node_modules/.bin/wrangler login`으로 로그인한다. 선택 계정에 두 도메인과 R2 버킷이 있어야 한다. 각 호스트의 DNS는 Proxied 상태여야 하며, 해당 `/cdn/*`를 가로채는 다른 Worker Route나 Access 정책이 없는지 확인한다.

## 기존 JSON 캐시 제거와 확인

이전에는 `/cdn/KR.png`가 원본 헤더 앱까지 전달되어 JSON으로 응답했다. 배포 후 Cloudflare의 `infiniteloopclub.cloud` 캐시 제거 화면에서 다음 URL만 Purge한다.

```text
https://infiniteloopclub.cloud/cdn/KR.png
```

Mac에서 두 번 실행한다.

```bash
curl -sS --connect-timeout 5 --max-time 15 -D - -o /dev/null \
  https://infiniteloopclub.cloud/cdn/KR.png
curl -sS --connect-timeout 5 --max-time 15 -D - -o /dev/null \
  https://infiniteloopclub.cloud/cdn/KR.png
```

| 확인 항목 | 기대 결과 |
| --- | --- |
| 상태 | `200` |
| Content-Type | `image/png` — JSON이면 아직 이미지 Worker 응답이 아님 |
| Cache-Control | `public, max-age=300` |
| X-Demo-Cache | `MISS` 또는 `HIT`; 캐시 작업 오류 시 `ERROR` |
| CF-Ray | 데이터센터 비교용. 다른 센터로 가거나 만료·퇴거되면 다시 MISS 가능 |

Cache API 동작은 이 코드가 추가하는 `X-Demo-Cache`로 확인한다. `CF-Cache-Status: HIT`만으로 올바른 이미지가 반환됐다고 판단하지 않는다. 캐시는 호스트별·데이터센터별로 달라 두 번째 요청이 반드시 HIT인 것은 아니다.

JSON이면 Worker 배포 및 Route 연결부터 확인한다. `KR.png is missing` 404면 연결된 R2 버킷의 객체 키가 정확히 `KR.png`인지 확인한다. 이 Worker는 R2 객체를 업로드하거나 수정하지 않는다.
