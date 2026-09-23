# Edge Access Lab

A small edge security and request inspection playground.

## Components

- `origin/`: HTTP origin that returns incoming request headers
- `worker/`: Access JWT verification, identity HTML and private R2 country flags (see [setup](worker/README.md))

## Origin endpoint

The origin service returns the request method, path, client address, and all incoming HTTP headers as JSON.

```bash
curl -H "X-Demo: edge-access-lab" http://localhost:8080/headers
```

## EC2 / DNS / Nginx / CloudWatch 설정

[실제 설정과 요청 흐름, 적용·복구·검증 방법](docs/origin-infrastructure.md)

- [루트/www HTTPS Nginx 설정](infra/nginx/infiniteloopclub.conf)
- [GitHub Actions로 Nginx 적용 및 Full / Full (strict) 비교](docs/tls-mode-demo.md)
- [CloudWatch Agent 로그 수집 설정](infra/cloudwatch/agent.json)
- [기존 Certbot HTTPS 설정 참고본](infra/nginx/snapshots/edge-access-lab.conf)

`origin/nginx.conf`는 초기 HTTP 설정이며 현재 EC2의 Certbot 적용 설정과 다릅니다.

Nginx 변경은 **Actions → Deploy Nginx TLS lab → Run workflow**에서 적용합니다.
`normal`은 정상 인증서, `mismatch`는 인증서 이름 불일치 실험입니다.
인증서/개인키는 EC2에 유지하며 SSH 접속 없이 SSM으로 배포합니다.

## 앱 로그 수집

[앱 로그 → CloudWatch 적용 및 확인](docs/app-logging.md). Git pull 후 서비스와 Agent 설정 적용이 필요합니다.
