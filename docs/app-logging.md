# 앱 로그를 CloudWatch로 보내기

## 코드와 설정의 역할

| 파일 | 역할 |
|---|---|
| origin/app.py | Python logging으로 요청·시작·오류 로그 기록, 파일 회전 |
| origin/header-inspector.service | ubuntu 계정의 로그 폴더 생성, APP_LOG_FILE 설정, journal 출력 |
| infra/cloudwatch/agent.json | 앱 파일을 CloudWatch /ec2/cloudflare-origin/app, {instance_id}/app으로 전송 |
| tests/test_origin_logging.py | 실제 HTTP 응답/로그, 회전, 예외, 로컬 실행 테스트 |

EC2에서는 /var/log/header-inspector/app.log에 한 줄 JSON으로 저장한다.
stdout에도 같은 내용을 출력하므로 journalctl -u header-inspector로 계속 볼 수 있다.
기존 journal 기록을 이전하는 기능은 아니며 배포 이후의 앱 로그부터 수집한다.
APP_LOG_FILE이 없는 로컬 실행은 파일 없이 콘솔에만 출력한다.

로그에는 직접 연결한 peer IP, 메서드, 쿼리를 제외한 경로, 응답 상태를 남긴다.
HTTP 응답의 헤더 반환 동작은 유지하지만 요청 헤더와 쿼리 문자열은 요청 로그에 복사하지 않는다.
request 기록은 send_response 시점의 상태이며 응답 본문 전송 완료를 보증하지 않는다. 처리 중 예외는 별도 ERROR 기록이다.
기동 실패 로그는 로깅 초기화가 완료된 경우 파일에도 남는다. 파일 권한 등 초기화 자체가 실패하면 journal에서 확인한다.

RotatingFileHandler는 약 10 MiB에서 회전하며 백업 5개(app.log.1 ~ .5)를 남긴다.
단일 앱 프로세스 안의 요청 스레드들이 동일 핸들러를 사용한다. 여러 앱 프로세스로 확장하면 로그 전략도 재검토한다.
Agent는 활성 app.log를 추적한다. 오래 중지되어 회전/삭제된 로그의 무손실 복구는 보장하지 않으므로 Agent 오류를 확인한다.
CloudWatch 보존 기간은 로컬 파일 회전과 별개이며 콘솔에서 설정한다.
JSON의 timestamp는 UTC 발생 시각이다. Agent timestamp_format은 설정하지 않아 CloudWatch 이벤트 시각과 차이가 날 수 있다.

## EC2 적용

이 저장소의 systemd unit은 /home/ubuntu/edge-access-lab/origin/app.py를 실행한다.
다른 경로나 추가 systemd drop-in을 쓰고 있다면 먼저 실제 unit과 비교해야 한다.
기존 Agent 설치와 EC2 IAM 역할이 준비된 환경을 전제로 한다. Nginx 설정은 변경하지 않는다.

### 1. 업데이트 전 백업

EC2 터미널에서 실행하고 같은 셸에서 이후 단계를 진행한다.
기존 로컬 변경이 있다면 먼저 검토한다.

```bash
cd /home/ubuntu/edge-access-lab
git status --short
sudo systemctl cat header-inspector
app_backup_dir=$(sudo mktemp -d /var/backups/header-inspector.XXXXXX)
sudo cp -a origin/app.py "$app_backup_dir/app.py"
sudo cp -a /etc/systemd/system/header-inspector.service "$app_backup_dir/header-inspector.service"
sudo cp -a /opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json "$app_backup_dir/agent.json"
echo "$app_backup_dir"
```

위 unit 경로가 없으면 systemctl cat에 나온 설치 경로를 사용한다.
이미 git pull 했다면 app.py 백업에는 새 코드가 들어간다. 코드 롤백이 필요할 때는 git log/reflog에서 이전 실행 커밋을 확인해 복구한다.

### 2. 병합된 코드 받기 및 검사

```bash
git switch main
git pull --ff-only
python3 -m unittest discover -s tests -v
python3 -m json.tool infra/cloudwatch/agent.json > /dev/null
sudo systemd-analyze verify origin/header-inspector.service
```

검사 실패 시 다음 단계로 진행하지 않는다.

### 3. 서비스 설치 및 재시작

```bash
sudo install -m 644 origin/header-inspector.service /etc/systemd/system/header-inspector.service
sudo systemctl daemon-reload
sudo systemctl restart header-inspector
sudo systemctl status header-inspector --no-pager
```

LogsDirectory=header-inspector가 ubuntu 소유의 /var/log/header-inspector를 만든다.
ProtectSystem=strict를 유지하면서 해당 로그 디렉터리에 쓰기를 허용한다.
앱 코드만 pull해도 기존 프로세스가 자동 갱신되지는 않는다.

### 4. Agent 설정 적용

```bash
sudo install -m 644 infra/cloudwatch/agent.json /opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json -s
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a status
```

### 5. 로그 확인

EC2에서:
```bash
curl -i --max-time 10 -H 'Host: infiniteloopclub.cloud' http://127.0.0.1/headers
sudo tail -n 10 /var/log/header-inspector/app.log
sudo journalctl -u header-inspector -n 20 --no-pager
```

서울 리전 CloudWatch → 로그 그룹 → /ec2/cloudflare-origin/app → 인스턴스 ID/app.
파일에 기록된 요청과 CloudWatch 이벤트를 비교하면 실제 전송 완료를 확인할 수 있다.
로그 그룹 보존 기간은 7일로 설정한다(이 JSON이 자동 변경하지 않음).

문제 발생 시:
```bash
sudo journalctl -u header-inspector -n 50 --no-pager
sudo tail -n 50 /opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log
```

기존 Agent는 root 기본 실행을 전제로 로그를 읽는다. 별도 run_as_user를 쓰면 0750 디렉터리/0640 파일 읽기 권한을 검토한다.

## 롤백

위에서 출력된 백업 경로와 그 안의 app.py가 이전 버전인지 확인한다. 같은 셸의 app_backup_dir를 사용한다.

```bash
sudo cp -a "$app_backup_dir/app.py" /home/ubuntu/edge-access-lab/origin/app.py
sudo cp -a "$app_backup_dir/header-inspector.service" /etc/systemd/system/header-inspector.service
sudo cp -a "$app_backup_dir/agent.json" /opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json
sudo systemctl daemon-reload
sudo systemctl restart header-inspector
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/cloudwatch-agent.json -s
```

복구하면 저장소 working tree가 Git과 달라질 수 있으므로 git diff로 확인한다.
이 문서 작성 시 로컬 테스트와 unit 정적 검사는 통과했다. EC2 적용 및 CloudWatch 실수신은 배포 후 별도로 확인해야 한다.

참고: [Python logging handlers](https://docs.python.org/3/library/logging.handlers.html).
