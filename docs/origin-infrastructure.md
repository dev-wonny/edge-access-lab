# EC2 설정과 요청 흐름

## 기록 범위와 확인 기준

2026-09-20 사용자가 제공한 nginx -T, DNS 조회, curl 응답 및 CloudWatch 화면을 기준으로 작성했다.
이 문서는 현재 실습 설정의 기록이며 AWS/Cloudflare 상태를 자동 동기화하는 Terraform은 아니다.
이 커밋 자체는 EC2에 배포하지 않는다.

## 어디에서 무엇을 관리하는가

| 구성 | 저장소 | 서버/콘솔 위치 |
|---|---|---|
| 새 도메인 HTTP 요청 전달 | infra/nginx/infiniteloopclub.conf | /etc/nginx/sites-available/infiniteloopclub |
| 활성화 링크 | 아래 적용 절차 | /etc/nginx/sites-enabled/infiniteloopclub |
| 기존 도메인 HTTPS 설정 참고본 | infra/nginx/snapshots/edge-access-lab.conf | /etc/nginx/sites-enabled/edge-access-lab |
| Nginx 로그 수집 | infra/cloudwatch/agent.json | /opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json |
| 헤더 반환 앱 | origin/app.py | systemd 서비스가 실행하는 앱 |
| 앱 서비스 정의 | origin/header-inspector.service | 실제 설치본은 systemctl cat header-inspector로 확인 |
| 네임서버 위임 | 이 문서 | 가비아 도메인 관리 |
| A/CNAME | 이 문서 | Cloudflare DNS → Records |
| 방화벽/IAM | 이 문서 | AWS EC2 보안 그룹/IAM |

origin/nginx.conf는 **초기 HTTP 부트스트랩 설정**이다. 현재 Certbot이 수정한 기존 도메인 설정과 다르므로 운영 파일 위에 그대로 복사하면 안 된다.
snapshots 파일은 참고용이며 자동 설치 대상이 아니다. nginx.conf의 http 블록은 sites-enabled/*를 include하고, /var/log/nginx/access.log 및 error.log를 사용한다.

## 실제 요청 흐름

1. DNS가 infiniteloopclub.cloud의 A 레코드로 EC2 Elastic IP 54.180.6.126을 반환한다.
2. www는 CNAME으로 infiniteloopclub.cloud를 가리킨다. 브라우저의 URL이나 HTTP Host가 바뀌는 리다이렉트가 아니다.
3. 보안 그룹이 방문자 공인 IP에서 TCP 80 접속을 허용한다.
4. Nginx가 Host와 server_name을 비교해 infiniteloopclub 설정을 선택한다.
5. location /가 경로를 유지한 채 127.0.0.1:8080으로 전달한다.
6. 저장소의 origin/app.py는 do_GET = handle_request 등으로 메서드를 연결한다. **/headers 전용 경로 분기는 없다.** GET /도 같은 핸들러가 처리한다.
7. 앱의 client_ip가 127.0.0.1인 이유는 같은 EC2의 Nginx가 직접 연결하기 때문이다. X-Real-IP에는 Nginx가 본 방문자 IP가 들어간다.

현재 새 도메인은 DNS only / HTTP다. Cloudflare 웹 프록시 및 이 도메인의 HTTPS는 아직 이 실습에서 검증하지 않았다.
외부에서 온 전달 헤더를 보안 판단에 사용할 때는 신뢰할 프록시 범위를 별도로 정해야 한다.

## DNS와 AWS 설정 기록

| 항목 | 확인한 값/상태 |
|---|---|
| 등록기관 | 가비아 |
| 권한 네임서버 | bill.ns.cloudflare.com / monroe.ns.cloudflare.com |
| A | @ → 54.180.6.126, DNS only, TTL Auto (조회 시 300초) |
| CNAME | www → infiniteloopclub.cloud, DNS only, TTL Auto |
| EC2 | cloudflare-origin, Ubuntu 24.04 amd64, ap-northeast-2 |
| SSH 인바운드 | TCP 22, 관리자의 현재 공인 IPv4/32 |
| HTTP 인바운드 | TCP 80, 실습 클라이언트의 현재 공인 IPv4/32 |
| 아웃바운드 | 제공된 화면 기준 전체 허용 |
| EC2 IAM 역할 | ec2-cloudwatch-agent-role 연결 확인 |
| Agent 권한 | 설정 가이드에서 CloudWatchAgentServerPolicy 사용; 로그 전송 성공 확인 |
| CloudWatch | /ec2/cloudflare-origin/nginx, {instance_id}/access 및 /error |
| 보존 기간 | 제공된 화면은 만기 없음. 7일 변경을 안내했으나 완료 미확인 |
| MX / DNSSEC | 이번 실습에서는 아직 설정 완료 미확인 |

SSH와 HTTP의 허용 출발지 IP는 네트워크 이동 시 달라질 수 있다. 개인 IP를 저장소에 고정하지 않고 콘솔의 '내 IP'로 갱신한다.
현재 HTTP가 내 IP에만 허용되어 있으므로 다른 방문자나 Cloudflare 프록시 접속에는 별도 검토가 필요하다.
EC2에 메일 서버를 설치한 것은 아니다. MX는 사용할 메일 서비스에서 지정한 서버 이름으로 설정해야 한다.

## 왜 404였는가

이전 80번 default_server는 origin.devwonny.win만 HTTPS로 리다이렉트하고, 그 외 Host에 return 404를 실행했다.
새 도메인 요청은 앱까지 전달되지 않았다. 새 server_name 설정을 추가한 뒤 루트/www의 /headers에서 모두 200 JSON 응답을 확인했다.

DNS 조회 성공, TCP 연결 성공, HTTP 404는 서로 다른 단계의 결과다. 404라고 DNS를 다시 바꾸지 않는다.

## 서버에서 현재 상태 확인

EC2에서:
```bash
sudo nginx -T
sudo systemctl cat header-inspector
sudo systemctl status header-inspector --no-pager
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a status
sudo cat /opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json
```

저장소 루트에서 설정 차이 확인 (주석/공백 차이도 출력된다):
```bash
sudo diff -u infra/nginx/infiniteloopclub.conf /etc/nginx/sites-available/infiniteloopclub
sudo diff -u infra/cloudwatch/agent.json /opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json
```

## 설정을 수정하고 적용하는 순서

먼저 Git에서 변경을 검토하고 해당 커밋을 EC2의 저장소로 가져온다. 아래 명령은 **EC2의 저장소 루트에서** 실행한다.
Nginx, 로컬 앱(8080), CloudWatch Agent, EC2 IAM 역할이 이미 준비된 서버를 대상으로 한다.

### Nginx

기존 실습 파일을 백업한다. 출력된 백업 경로를 보관한다.
```bash
backup_dir=$(sudo mktemp -d /var/backups/edge-access-lab.XXXXXX)
sudo cp -a /etc/nginx/sites-available/infiniteloopclub "$backup_dir/infiniteloopclub"
echo "$backup_dir"
sudo install -m 644 infra/nginx/infiniteloopclub.conf /etc/nginx/sites-available/infiniteloopclub
sudo nginx -t && sudo systemctl reload nginx
```

기존 서버의 활성화 링크는 그대로 사용한다. 새 서버라면 sites-enabled에 동일 이름 파일이 없는 것을 확인한 뒤 다음 링크가 필요하다:
```bash
sudo ln -s /etc/nginx/sites-available/infiniteloopclub /etc/nginx/sites-enabled/infiniteloopclub
```

검사 또는 reload 실패 시 같은 셸에서 백업 파일을 복구하고 다시 검사한다:
```bash
sudo cp -a "$backup_dir/infiniteloopclub" /etc/nginx/sites-available/infiniteloopclub
sudo nginx -t && sudo systemctl reload nginx
```

### CloudWatch Agent

```bash
cw_backup_dir=$(sudo mktemp -d /var/backups/edge-cloudwatch.XXXXXX)
sudo cp -a /opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json "$cw_backup_dir/agent.json"
echo "$cw_backup_dir"
python3 -m json.tool infra/cloudwatch/agent.json > /dev/null
sudo install -m 644 infra/cloudwatch/agent.json /opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json -s
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a status
```

실패하면 백업을 복원하고 동일 fetch-config 명령으로 다시 적용한다.
```bash
sudo cp -a "$cw_backup_dir/agent.json" /opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json -s
```

수집 범위는 Nginx 두 로그 파일뿐이다. Python 앱의 stdout/systemd journal은 이 설정으로 수집하지 않는다.
error.log가 비어 있으면 error 스트림이 아직 나타나지 않을 수 있다.
timestamp_format을 설정하지 않았으므로 CloudWatch 이벤트 시각과 Nginx 메시지 안의 요청 시각이 다를 수 있다.
보존 기간은 콘솔에서 7일로 변경하고 결과를 별도 확인한다.

## 동작 검증과 장애 위치

맥에서:
```bash
dig NS infiniteloopclub.cloud @1.1.1.1
dig A infiniteloopclub.cloud @1.1.1.1
dig A www.infiniteloopclub.cloud @1.1.1.1
curl -i --max-time 10 http://infiniteloopclub.cloud/headers
curl -i --max-time 10 http://www.infiniteloopclub.cloud/headers
```

EC2 내부에서 DNS/보안 그룹을 거치지 않고 Nginx와 앱을 비교:
```bash
curl -i --max-time 10 http://127.0.0.1:8080/headers
curl -i --max-time 10 -H 'Host: infiniteloopclub.cloud' http://127.0.0.1/headers
sudo tail -n 20 /var/log/nginx/access.log
sudo tail -n 50 /opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log
```

| 증상 | 확인할 곳 |
|---|---|
| DNS 응답 없음 | NS 위임, A/CNAME, 리졸버 캐시 |
| TCP 접속 timeout | SG의 현재 출발지 IP/포트, 네트워크 경로 |
| Nginx 404 | server_name 선택과 return/location |
| 502 | 8080 앱 상태 및 proxy_pass |
| CloudWatch 로그 없음 | Agent 상태, IAM, 파일 경로, 전송 로그 |

2026-09-20 증거: NS 2개 정상 응답, A 및 www CNAME 정상 응답, 루트/www /headers 200 OK, Agent running/configured, CloudWatch access 이벤트 수신.
이 기록은 사용자가 실행한 결과이며 이 커밋 작성 환경에서 EC2 재배포/재검증한 결과는 아니다.

## 앞으로의 변경 원칙

설정 변경 → Git diff/PR → 서버 적용 → nginx -T 및 curl/로그 검증 순서로 관리한다.
긴급 서버 수정이 필요했다면 동일 변경을 Git에도 반영한다.
인증서 개인키, SSH .pem, API 토큰은 커밋하지 않는다.
DNS/SG/IAM을 자동 배포하려면 기존 리소스를 Terraform으로 import하고 plan을 검토하는 작업이 별도로 필요하다.
