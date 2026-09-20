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

- [새 도메인 HTTP Nginx 설정](infra/nginx/infiniteloopclub.conf)
- [CloudWatch Agent 로그 수집 설정](infra/cloudwatch/agent.json)
- [기존 Certbot HTTPS 설정 참고본](infra/nginx/snapshots/edge-access-lab.conf)

`origin/nginx.conf`는 초기 HTTP 설정이며 현재 EC2의 Certbot 적용 설정과 다릅니다.
