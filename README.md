# Edge Access Lab

A small edge security and request inspection playground.

## 평가자 접근 안내 (Reviewer Access Guide)

별도 설치 없이 브라우저 또는 `curl`로 확인할 수 있습니다.

| 과제 | 확인 항목 | URL / 방법 | 기대 결과 |
|---|---|---|---|
| 1, 2 | 헤더 에코 (Cloudflare 프록시 경유) | https://origin.devwonny.win/ | 요청 헤더 JSON. `Cf-Connecting-Ip`, `Cf-Ray`, `Cf-Ipcountry` 포함 |
| 3 | Full (Strict) + 외부 발급 인증서 | 원본 Nginx에 Let's Encrypt 인증서 적용 | 정상 응답. 인증서 불일치 실험은 [TLS 모드 비교](docs/tls-mode-demo.md) 참고 |
| 4 | Rate Limiting | https://tunnel.devwonny.win/rate-limit-test (같은 IP 기준 10초에 5회 초과 시 10초 차단, 존 전체 적용) | 초과 시 `429`와 `Retry-After` 헤더 |
| 5 | Cloudflare Tunnel | https://tunnel.devwonny.win/ | 헤더 에코 JSON에 `Cf-Warp-Tag-Id` 헤더 포함 (Tunnel 경유 증거) |
| 6, 7 | Zero Trust SSO + 경로 접근 제한 | https://tunnel.devwonny.win/secure | Access 로그인 화면으로 이동. `@cloudflare.com` 이메일은 One-time PIN으로 로그인 |
| 7 | 원본 IP 직접 접근 차단 | `curl -m 5 https://54.180.6.126/` | 타임아웃 (Security Group이 Cloudflare IP 대역만 허용) |
| 8 | Worker 인증 정보 페이지 | https://tunnel.devwonny.win/secure | `${EMAIL} authenticated at ${TIMESTAMP} from ${COUNTRY}` HTML |
| 8 | 국기 이미지 (비공개 R2) | 위 페이지의 국가 링크 클릭 (예: `/secure/KR`) | `Content-Type: image/png` 국기 이미지 |

### 빠른 확인 명령어

```bash
# Cloudflare 프록시 경유 헤더 확인
curl -s https://origin.devwonny.win/ | grep -i -A1 -E 'cf-connecting-ip|cf-ray|cf-ipcountry'

# Tunnel 경유 확인 (Cf-Warp-Tag-Id 헤더)
curl -s https://tunnel.devwonny.win/ | grep -i -A1 'cf-warp-tag-id'

# Rate Limiting: 같은 연결로 20회 → 1~5는 200, 6번째부터 429
curl --http2 -sS -o /dev/null -w '%{http_code} %header{cf-ray}\n' 'https://tunnel.devwonny.win/rate-limit-test?demo=[1-20]'

# 원본 IP 직접 접근: 타임아웃 (Cloudflare 우회 불가)
curl -m 5 -k https://54.180.6.126/ || echo "blocked (timeout)"

# 인증 없이 /secure 접근 시 Access 로그인으로 리다이렉트 (302)
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" https://tunnel.devwonny.win/secure
```

### 참고: 의도적으로 둔 비교용 구성

| 구성 | 목적 |
|---|---|
| `infiniteloopclub.cloud` 루트 A 레코드 (Proxied) | `/cdn/*`는 `flag-cdn-demo` Worker로, 그 외 경로는 원본으로 전달한다. DNS only로 바꾸면 Worker Route를 거치지 않는다. |
| https://infiniteloopclub.cloud/cdn/KR.png | Workers Cache API 공개 데모. 비공개 R2의 `KR.png` 한 장만 공개하며, 같은 데이터센터의 캐시에 있으면 `X-Demo-Cache: HIT`. [배포 및 확인](worker-cdn/README.md) |
| https://tunnel.devwonny.win/cdn/KR.png | 같은 `flag-cdn-demo` Worker의 기존 주소. 호스트별 캐시 키는 별도다. |

## Components

- `origin/`: HTTP origin that returns incoming request headers
- `worker/`: Access JWT verification, identity HTML and private R2 country flags (see [setup](worker/README.md))
- `worker-cdn/`: 공개 `/cdn/KR.png` 이미지와 Cache API 데모 (see [setup](worker-cdn/README.md))

## Origin endpoint

The origin service returns the request method, path, client address, and all incoming HTTP headers as JSON.

```bash
curl -H "X-Demo: edge-access-lab" http://localhost:8080/headers
```

## EC2 / DNS / Nginx / CloudWatch 설정

[실제 설정과 요청 흐름, 적용·복구·검증 방법](docs/origin-infrastructure.md)

- [루트/www HTTPS Nginx 설정](infra/nginx/infiniteloopclub.conf)
- [devwonny.win 루트/www 인증서 및 HTTPS 배포](docs/devwonny-https.md)
- [GitHub Actions로 Nginx 적용 및 Full / Full (strict) 비교](docs/tls-mode-demo.md)
- [CloudWatch Agent 로그 수집 설정](infra/cloudwatch/agent.json)
- [기존 Certbot HTTPS 설정 참고본](infra/nginx/snapshots/edge-access-lab.conf)

`origin/nginx.conf`는 초기 HTTP 설정이며 현재 EC2의 Certbot 적용 설정과 다릅니다.

Nginx 변경은 **Actions → Deploy Nginx TLS lab → Run workflow**에서 적용합니다.
`site: infiniteloopclub`에서 `normal`은 정상 인증서, `mismatch`는 인증서 이름 불일치 실험입니다.
`site: devwonny`, `certificate_mode: normal`은 루트/www용 인증서를 DNS-01로 발급하고 별도 사이트에 적용합니다.
인증서/개인키는 EC2에 유지하며 SSH 접속 없이 SSM으로 배포합니다.

## 앱 로그 수집

[앱 로그 → CloudWatch 적용 및 확인](docs/app-logging.md). Git pull 후 서비스와 Agent 설정 적용이 필요합니다.
