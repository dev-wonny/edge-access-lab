# EC2 Python 자동 배포

현재 GitHub Actions의 `Deploy Python origin`은 아래 배포 스크립트를 SSM으로 실행한다.
이 방식과 systemd timer를 동시에 사용하지 않는다. 아래 timer 설치는 이전 방식의 기록이다.
Nginx는 [별도의 Actions 워크플로](tls-mode-demo.md)에서 적용·복원한다.

EC2의 systemd timer가 약 1분마다 GitHub main을 확인한다. Webhook 방식이 아니므로 빌드/네트워크 시간을 더한 지연이 있다. SSH 인바운드를 추가로 열지 않는다. Worker의 Cloudflare Builds와 독립적으로 동작한다.

## 범위와 전제

- 저장소: /home/ubuntu/edge-access-lab, 브랜치 main, 실행 사용자 ubuntu.
- ubuntu가 비대화식 git fetch 및 sudo -n systemctl restart header-inspector를 실행할 수 있어야 한다. AWS Ubuntu 기본 sudo 설정을 전제로 하며 이 설치는 sudo 권한을 추가하지 않는다.
- main에 병합할 수 있는 사람은 EC2의 ubuntu 권한으로 테스트/앱 코드를 실행할 수 있다. 신뢰한 변경만 병합한다.
- Python 코드는 origin에 위치하고 외부 패키지가 없는 현재 구성을 대상으로 한다.
- 후보 커밋의 tests 테스트 통과 후 fast-forward, origin 변경이 있으면 재시작하고 로컬 HTTP 응답을 확인한다. Worker만 바뀌면 Python 재시작을 생략한다.
- 실패하면 이전 커밋으로 복구를 시도하고 같은 실패 커밋은 다시 배포하지 않는다. 복구 실패는 journal에서 확인한다. 단일 프로세스 재시작이므로 짧은 중단이 있다.
- Nginx, cloudflared, CloudWatch Agent, systemd 설정 파일은 자동 설치하지 않는다. 배포 스크립트 자체 변경도 아래 설치를 다시 해야 한다.
- 배포 도중 수동 Git 작업을 하지 않는다. 로컬 변경/분기 이력이 있으면 중단한다.

## 최초 설치 (EC2에서 한 번)

이 PR을 main에 병합한 다음 실행한다. git status가 깨끗하고 현재 브랜치가 main인지 먼저 확인한다.

```bash
cd /home/ubuntu/edge-access-lab
git status --short
git branch --show-current
git pull --ff-only origin main
sudo install -m 755 infra/deploy/origin-auto-deploy.sh /usr/local/bin/origin-auto-deploy
sudo install -m 644 infra/deploy/origin-auto-deploy.service /etc/systemd/system/
sudo install -m 644 infra/deploy/origin-auto-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now origin-auto-deploy.timer
sudo systemctl start origin-auto-deploy.service
systemctl list-timers origin-auto-deploy.timer
```

최초 설치 직전 pull은 실행 중인 Python 프로세스를 바꾸지 않는다. 설치 시점의 코드를 실행하려면 다음을 한 번 실행한다.

```bash
sudo systemctl restart header-inspector
curl --fail --max-time 5 http://127.0.0.1:8080/headers
```

## 확인과 중지

main에 origin 코드 변경을 병합한 뒤 확인한다. 타이머 설치만으로 실제 자동 배포 검증이 완료되는 것은 아니다.

```bash
sudo journalctl -u origin-auto-deploy -n 50 --no-pager
sudo journalctl -u header-inspector -n 20 --no-pager
git -C /home/ubuntu/edge-access-lab log -1 --oneline
```

실패 원인을 고친 뒤 같은 커밋을 다시 시도:

```bash
rm -f /home/ubuntu/.local/state/origin-auto-deploy/failed
sudo systemctl start origin-auto-deploy.service
```

자동 배포 중지 (앱은 계속 실행):

```bash
sudo systemctl disable --now origin-auto-deploy.timer
```

이미 실행 중인 배포는 타이머 중지 후에도 완료될 수 있다. 서비스 상태를 확인한 뒤 수동 작업한다.
