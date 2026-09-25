# devwonny.win 루트/www HTTPS 배포

`devwonny.win`, `www.devwonny.win`은 Cloudflare Proxied로 EC2 `54.180.6.126`을
가리킨다. DNS 레코드만 추가하면 Nginx의 기본 사이트가 `origin.devwonny.win` 전용
인증서를 반환해 Full (strict)에서 526이 발생한다.

## 저장소와 서버 설정

| 항목 | 위치 |
|---|---|
| 루트/www Nginx 설정 | `infra/nginx/devwonny.conf` |
| 발급·배포·검증·복구 | `infra/deploy/deploy-devwonny.sh` |
| EC2 활성 설정 | `/etc/nginx/sites-available/devwonny`, `sites-enabled/devwonny` 링크 |
| 새 인증서 | `/etc/letsencrypt/live/devwonny.win/` |

`origin.devwonny.win`의 설정과 인증서는 기존 TLS 비교 실험에도 쓰이므로 별도로 유지한다.
루트/www는 동일한 `127.0.0.1:8080` 헤더 검사 앱으로 전달한다.

## 배포

main에 변경을 병합한 뒤 **Actions → Deploy Nginx TLS lab → Run workflow**에서:

- Branch: `main`
- `site`: `devwonny`
- `certificate_mode`: `normal`

PR과 push에서는 테스트만 실행한다. 실제 서버 변경은 수동 workflow dispatch로 실행한다.
기존 `infiniteloopclub`의 normal/mismatch 실행은 그대로 사용한다.

### 인증서 발급 전제

서버의 기존 `/etc/letsencrypt/renewal/origin.devwonny.win.conf`에서
`dns-cloudflare` 인증 방식, 자격증명 **파일 경로**, ACME 계정/서버를 재사용한다.
기존 Cloudflare 토큰은 `devwonny.win` 존의 DNS 레코드를 수정할 수 있어야 한다.
토큰 내용과 인증서 개인키는 EC2 내부에 머무르며 GitHub/SSM 출력에 전달하지 않는다.

새 인증서가 없을 때만 Certbot DNS-01로 루트/www 인증서를 발급한다.
현재 보안 그룹은 Cloudflare IPv4의 443만 허용하고 80은 닫혀 있으므로,
HTTP-01 방식인 `certbot --nginx`를 사용하지 않는다. 방화벽이나 Cloudflare SSL 모드
변경 없이 임시 DNS TXT 레코드로 소유권을 확인하고 Certbot이 레코드를 정리한다.

발급 시 Nginx 설정 검사와 reload를 수행하는 deploy hook을 함께 저장한다.
이후 갱신은 기존 Certbot 타이머가 담당한다. 성공적으로 발급된 인증서는 Nginx 적용이
실패해도 유지하며, 다음 배포에서 재사용한다.

## 검증과 복구

배포 전 앱과 Nginx 설정을 검사한다. 기존 devwonny 사이트가 있으면 백업하고,
새 설정 적용 후 EC2 내부에서 **두 도메인 각각**의 SNI/인증서와 GET 응답을 검증한다.
실패하면 직전 설정을 복원하거나 새로 만든 사이트만 제거하고 Nginx를 reload한다.
기존 origin/infiniteloopclub 설정을 덮어쓰지 않는다.

외부 검증은 HEAD 대신 GET으로 한다. 앱은 HEAD를 구현하지 않아 `curl -I`는 501일 수 있다.

```bash
curl -sS --max-time 30 -o /dev/null -w '%{http_code}\n' https://devwonny.win/headers
curl -sS --max-time 30 -o /dev/null -w '%{http_code}\n' https://www.devwonny.win/headers
```

기대 결과는 각각 200이다. 프록시 경유 인증서 검사는 방문자→Cloudflare 구간을
확인하므로, 원본 인증서 검증은 Actions의 EC2 로컬 검사 결과와 함께 확인한다.
