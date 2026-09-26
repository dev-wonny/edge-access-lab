# 공개 국기 CDN 데모 배포

`https://infiniteloopclub.cloud/cdn/KR.png`는 `flag-cdn-demo` Worker가 비공개 R2 버킷 `edge-access-lab-flags`의 `KR.png`를 읽어 응답하는 주소다. 기존 `https://tunnel.devwonny.win/cdn/KR.png`도 유지한다. 삭제한 `tunnel.infiniteloopclub.cloud`는 사용하지 않는다.

## 요청 흐름

1. Cloudflare의 Proxied DNS 호스트로 요청한다.
2. `wrangler.jsonc`의 `/cdn/*` Route가 이 Worker를 실행한다.
3. Cache API에 이미지가 있으면 반환하고, 없으면 R2의 `KR.png`를 읽어 저장을 시도한다.

EC2, Tunnel, Nginx를 거치지 않는다. `/cdn/`용 Nginx 설정이나 EC2 파일 복사가 필요 없다. 버킷의 공개 접근을 켤 필요도 없다. Worker가 공개하는 객체는 `KR.png` 하나이며 다른 경로는 404다. 기존 `/secure`의 Access 보호는 별도 Worker에서 유지한다.

이 Worker는 `worker/`의 `edge-access-lab` Worker 및 `/cdn-demo/*` 데모와 별도다. `worker/`만 배포하면 여기의 Route는 반영되지 않는다.

## GitHub Actions 자동 배포

`.github/workflows/deploy-cdn-worker.yml`의 **Deploy CDN Worker**가 이 Worker를 배포한다.

- PR: 고정 버전 Wrangler로 `--dry-run` 검증만 실행한다. 배포 토큰은 제공하지 않는다.
- main 병합: `worker-cdn/**`, Wrangler 의존성 파일 또는 이 워크플로가 변경되면 검증 후 자동 배포한다.
- 수동 재실행: Actions → Deploy CDN Worker → Run workflow → main.
- 배포 후 두 공개 주소의 HTTP 200, image/png, PNG 시그니처, X-Demo-Cache를 확인한다. HTTP 200 JSON은 실패로 처리한다. 데이터센터별 캐시이므로 HIT만 요구하지 않고 정상 MISS도 허용한다.

### 최초 1회 인증 설정

1. Cloudflare의 API Tokens에서 **Edit Cloudflare Workers** 템플릿으로 토큰을 만든다. 계정은 이 프로젝트 계정으로 제한하고, Route 권한은 `devwonny.win`, `infiniteloopclub.cloud` 두 존에 부여한다. Worker 배포 권한과 두 존의 Workers Routes 편집 권한이 필요하다. R2 객체는 런타임 FLAGS 바인딩으로 읽으며 이 워크플로는 R2에 업로드하지 않는다.
2. GitHub 저장소 → Settings → Secrets and variables → Actions → New repository secret에서 **CLOUDFLARE_API_TOKEN**으로 저장한다. 토큰 값은 코드·문서·채팅에 넣지 않는다.
3. 계정 ID는 워크플로에 기존 프로젝트 값으로 지정되어 있어 추가 Secret이 필요 없다.
4. 이 설정을 병합 전에 끝내면 병합 시 자동 배포된다. 병합 후 등록했다면 main에서 Run workflow로 실행한다.

Cloudflare Builds에도 **동일한 flag-cdn-demo**가 연결돼 있다면 중복 배포되지 않도록 배포 담당을 GitHub Actions 하나로 정한다. 별도 `edge-access-lab` Worker의 Builds는 이 워크플로 대상이 아니다.

Secret 관리 권한이 없는 GitHub 연결에서는 토큰을 대신 등록할 수 없다. 워크플로 파일만 추가한 상태는 실제 배포 완료가 아니며, Actions의 deploy 및 응답 검증 성공까지 확인한다.

공식 문서: [Workers GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [Worker 배포 및 Route 권한](https://developers.cloudflare.com/workers/authorization/).

## Mac에서 수동 배포 (선택)

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
