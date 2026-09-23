# EC2 접속 없이 Full / Full (strict) 비교

GitHub Actions가 저장소의 Nginx 설정을 AWS SSM으로 EC2에 적용한다.
`www.infiniteloopclub.cloud`를 그대로 사용한다. 새 DNS 이름은 필요 없다.

## 저장소에서 관리하는 것

| 파일 | 역할 |
|---|---|
| `infra/nginx/infiniteloopclub.conf` | 루트/www의 정상 HTTPS 설정 |
| `infra/deploy/deploy-nginx.sh` | 정상/불일치 인증서 선택, 백업, 검사, reload, 실패 시 복구 |
| `.github/workflows/deploy-nginx.yml` | GitHub Actions → AWS OIDC → SSM 실행 |

인증서와 개인키는 EC2의 `/etc/letsencrypt`에 그대로 둔다.
이 배포는 인증서를 발급하거나 덮어쓰지 않고 Nginx의 인증서 **경로**를 선택한다.
Cloudflare의 Full / Full (strict) 선택은 Cloudflare 콘솔에서 한다.

## 현재 환경의 전제

- 기존 `Deploy Python origin`과 같은 GitHub 변수 `AWS_REGION`, `AWS_ROLE_ARN`, `EC2_INSTANCE_ID`를 사용한다.
- 해당 AWS 역할에 기존 SSM 명령 전송/결과 조회 권한이 있고 EC2 SSM Agent가 온라인이어야 한다.
- Nginx와 Python `127.0.0.1:8080`이 실행 중이어야 한다.
- EC2에 `infiniteloopclub.cloud`(루트/www 포함), `origin.devwonny.win` 인증서가 이미 있어야 한다.
- `www.infiniteloopclub.cloud`는 Proxied이며 Cloudflare에서 EC2 443에 접속할 수 있어야 한다.

실습에서 이 조건으로 두 도메인의 `/headers`가 200을 반환한 것을 확인했다.
새 배포 흐름 자체의 EC2 실행 여부는 Actions 결과로 별도 확인한다.

## 실행 순서

먼저 이 변경을 `main`에 병합한다. PR과 push에서는 배포 스크립트 테스트만 실행한다.
실제 EC2 변경은 **Actions → Deploy Nginx TLS lab → Run workflow**에서만 실행한다.
브랜치는 `main`을 선택한다. EC2에서 스크립트를 따로 설치하거나 `git pull`할 필요가 없다.

1. `certificate_mode: normal`로 실행하고 `deploy` 작업의 성공을 확인한다.
2. Cloudflare에서 `infiniteloopclub.cloud` → **SSL/TLS → Configure** → **Full**을 선택한다.
3. 아래 curl로 200 응답을 확인한다.
4. Actions를 `certificate_mode: mismatch`로 실행한다. Nginx가 www 요청에 `origin.devwonny.win` 인증서를 제시한다.
5. 같은 curl을 실행한다. Full은 원본 인증서의 이름을 검증하지 않아 200이 예상된다.
6. Cloudflare를 **Full (strict)**로 바꾸고 같은 curl을 실행한다. 이름 불일치로 526이 예상된다.
7. Actions를 **`normal`로 다시 실행**한다. Full (strict)에서도 200으로 돌아오는지 확인한다.

```bash
curl -sS --connect-timeout 5 --max-time 30 \
  -D - -o /dev/null \
  https://www.infiniteloopclub.cloud/headers
```

| EC2에서 제시하는 인증서 | Cloudflare Full | Cloudflare Full (strict) |
|---|---|---|
| `infiniteloopclub.cloud` / `www.infiniteloopclub.cloud` 포함 | 200 | 200 |
| `origin.devwonny.win`만 포함 | 200 | 526 |

위 표는 원본 연결과 앱이 정상이고 별도 SSL 규칙/캐시가 개입하지 않는 조건의 예상 결과다.
522가 나오면 원본 접속 문제부터 확인한다. 525는 TLS 협상 실패여서 이름 검증 실험과 구분한다.
`/headers` 응답의 `cf-cache-status: DYNAMIC`도 함께 확인한다.

**루트와 www가 같은 Nginx 블록을 사용한다.** `mismatch` 동안 DNS only인 루트 도메인에
직접 접속하면 브라우저에서도 인증서 오류가 난다. 실습 종료 후 `normal`을 실행한다.
Cloudflare 모드는 해당 zone의 다른 프록시 호스트에도 영향을 줄 수 있다.

## 원본 인증서까지 직접 확인하기

프록시 경유 curl의 `SSL certificate verify ok`는 맥북이 Cloudflare 앞쪽 인증서를 검증했다는 뜻이다.
EC2가 제시하는 인증서를 맥북에서 보려면 다음을 사용한다.
이 요청은 **맥북 공인 IP의 EC2 443 접근이 허용된 경우에만** 동작한다.
Cloudflare IP만 허용했다면 시간 초과가 나므로 Actions의 로컬 검사 결과를 보면 된다.

```bash
curl -v --connect-timeout 5 --max-time 15 \
  --resolve www.infiniteloopclub.cloud:443:54.180.6.126 \
  -o /dev/null \
  https://www.infiniteloopclub.cloud/headers
```

- `normal`: EC2 인증서의 SAN 이름 일치, 검증 성공, HTTP 200.
- `mismatch`: 이름 불일치로 `curl: (60)`. HTTP 요청 전송 전에 실패한다.

## 배포가 실패하면

적용 전에 `/var/backups/edge-access-lab-nginx/deploy.*`에 기존 설정을 보관한다.
기존 활성화 링크를 유지하고, 변경 후 `nginx -t`와 reload, 로컬 HTTPS 요청을 확인한다.
실패하면 직전 설정을 복구하고 다시 reload한다. 복구 실패도 SSM 출력에 표시한다.
`mismatch`의 로컬 검사에서는 의도한 인증서 검증 실패인 curl 종료 코드 60을 기대한다.
연결 실패나 5xx를 성공으로 처리하지 않는다.

`normal`은 **저장소의 정상 설정**을 적용한다. 임의의 과거 수동 변경을 복원하는 모드는 아니다.
실험 성공 상태는 자동으로 해제되지 않으므로 마지막에 `normal`을 실행해야 한다.
실행 중인 SSM 명령이 남을 수 있어, Actions 대기를 취소한 경우 SSM 실행 결과부터 확인한다.

## 로컬 검증 범위

```bash
bash -n infra/deploy/deploy-nginx.sh
python3 -m unittest discover -s infra/tests -v
```

격리된 파일과 가짜 nginx/systemctl/curl로 링크 보존, 백업, 모드 전환,
설정 오류·reload 실패·연결 실패 시 복구를 검사한다. 실제 Nginx와 Cloudflare 결과를 대신하지 않는다.

참고: [Cloudflare Full](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full/),
[Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/),
[Nginx reload](https://nginx.org/en/docs/control.html).
