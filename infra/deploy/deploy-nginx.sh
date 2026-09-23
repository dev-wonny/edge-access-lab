#!/usr/bin/env bash
# GitHub Actions가 AWS SSM으로 전달하며, 이 스크립트는 EC2에서 root로 실행된다.
# 흐름: 모드 선택 → 사전 검사 → 백업 → 설정 적용 → 로컬 HTTPS 검사 → 실패 시 복구.
# 인증서/개인키는 EC2에 그대로 두고 Nginx가 참조하는 인증서 경로만 선택한다.
# Cloudflare의 Full / Full (strict) 모드는 별도로 콘솔에서 변경한다.
# -e: 처리하지 않은 명령 실패 시 종료, -u: 미정의 변수 사용 시 종료.
# pipefail: 파이프라인 중간 명령의 실패도 파이프라인 실패로 처리한다.
set -euo pipefail

# 1. 첫 번째 인자가 없거나 비어 있으면 normal을 사용한다.
# 예: bash infra/deploy/deploy-nginx.sh mismatch
# normal은 저장소의 정상 설정을 적용하며, 임의의 과거 백업을 복원하는 모드가 아니다.
mode=${1:-normal}
case "$mode" in
  normal) certificate_name=infiniteloopclub.cloud ;;
  mismatch) certificate_name=origin.devwonny.win ;;
  *) echo "Usage: $0 [normal|mismatch]" >&2; exit 2 ;;
esac

# 2. 실행한 현재 디렉터리와 무관하게 스크립트 위치를 기준으로 설정 원본을 찾는다.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_config="$script_dir/../nginx/infiniteloopclub.conf"
# 아래 경로 변수는 테스트에서 임시 파일을 검사/수정하기 위해 재정의할 수 있다.
# 실제 Actions 배포에서는 기본 /etc 및 /var 경로를 사용한다.
# 설정 원본 안의 인증서 절대 경로는 실제 EC2의 /etc/letsencrypt를 기준으로 한다.
nginx_root=${NGINX_ROOT:-/etc/nginx}
certbot_root=${CERTBOT_ROOT:-/etc/letsencrypt}
backup_root=${BACKUP_ROOT:-/var/backups/edge-access-lab-nginx}
enabled="$nginx_root/sites-enabled/infiniteloopclub"

mkdir -p "$backup_root"
# 3. 파일 디스크립터 9로 잠금을 잡아 같은 스크립트의 동시 적용을 막는다.
# 최대 30초 기다린 뒤에도 잠금을 얻지 못하면 종료한다. 종료 시 잠금은 해제된다.
exec 9>"$backup_root/deploy.lock"
flock -w 30 9

# 4. sites-enabled의 링크는 유지하고, 링크가 가리키는 실제 설정 파일을 수정한다.
# 링크 없이 sites-enabled에 일반 파일을 둔 설치도 허용한다.
test -f "$enabled"
target=$(readlink -f -- "$enabled")
# 예상한 두 위치 이외의 파일을 가리키면 다른 사이트 설정을 덮어쓰지 않도록 중단한다.
case "$target" in
  "$nginx_root/sites-available/infiniteloopclub"|"$enabled") ;;
  *) echo "Unexpected Nginx target: $target" >&2; exit 1 ;;
esac
# 선택한 인증서 체인과 개인키 파일이 존재하고 비어 있지 않은지 확인한다.
# test -s 자체는 인증서의 유효기간이나 도메인 일치를 검증하지 않는다.
for file in fullchain.pem privkey.pem; do
  test -s "$certbot_root/live/$certificate_name/$file" || {
    echo "Missing certificate file: $certbot_root/live/$certificate_name/$file" >&2
    exit 1
  }
done
# 기존 Nginx 설정과 Python 앱이 정상인지 변경 전에 확인한다.
# 이 curl은 EC2 내부의 Python 앱에 직접 접속한다. --noproxy는 프록시 환경변수를 무시한다.
nginx -t
curl --fail --silent --show-error --noproxy '*' --max-time 5 \
  -o /dev/null http://127.0.0.1:8080/headers

# 5. 매번 고유한 백업 폴더를 생성하고 직전 Nginx 설정을 보관한다.
# cp -p는 파일 권한 등 속성을 보존한다. 인증서/개인키 내용은 복사하지 않는다.
backup=$(mktemp -d "$backup_root/deploy.XXXXXXXX")
cp -p -- "$target" "$backup/previous.conf"
# Actions가 전달한 Git 커밋 번호도 기록해 어떤 버전을 적용했는지 추적한다.
printf 'mode=%s\nrevision=%s\ntarget=%s\n' \
  "$mode" "${DEPLOY_REVISION:-local}" "$target" > "$backup/deployment.txt"
echo "Backup: $backup"

# 6. 설정 변경을 시작했지만 검사를 끝내지 못한 경우에만 자동 복구한다.
changed=0
complete=0
cleanup() {
  # $?는 cleanup 진입 직전 종료 코드다. trap을 해제하고 이 코드를 반환한다.
  result=$?
  trap - EXIT
  if (( changed && ! complete )); then
    echo "Deployment failed; restoring $backup/previous.conf" >&2
    # 저장소의 normal 설정이 아니라 이번 실행 직전의 실제 설정으로 되돌린다.
    # 예: mismatch 상태에서 normal 배포가 실패했다면 직전 mismatch 설정이 복구된다.
    if cp -p -- "$backup/previous.conf" "$target" && nginx -t && systemctl reload nginx; then
      echo "Previous Nginx configuration restored" >&2
    else
      echo "ROLLBACK FAILED: inspect SSM output and $backup" >&2
    fi
    result=1
  fi
  exit "$result"
}
# 일반 종료/오류 종료 시 cleanup을 호출한다. INT/TERM도 종료 후 복구 경로를 거친다.
# 강제 종료(SIGKILL)나 서버 중단까지 복구를 보장하는 것은 아니다.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 7. 저장소 원본은 유지하고 candidate.conf에 적용할 설정을 만든다.
# normal: /live/infiniteloopclub.cloud/, mismatch: /live/origin.devwonny.win/.
# 인증서와 개인키의 경로를 함께 바꾸고 server_name은 루트/www 그대로 둔다.
# 두 호스트가 같은 server 블록을 쓰므로 mismatch는 루트 직접 HTTPS에도 영향을 준다.
sed "s|/etc/letsencrypt/live/infiniteloopclub.cloud/|/etc/letsencrypt/live/$certificate_name/|g" \
  "$source_config" > "$backup/candidate.conf"
changed=1
# install은 설정 파일 복사이며 644는 소유자 쓰기/모두 읽기 권한이다.
# 설정 검사 통과 후 reload로 Nginx에 반영한다. 실패하면 EXIT의 cleanup이 복구를 시도한다.
install -m 644 -- "$backup/candidate.conf" "$target"
nginx -t
systemctl reload nginx

# 8. EC2 내부 Nginx에 직접 요청해 적용 결과를 검사한다.
# --resolve로 접속 IP만 127.0.0.1로 지정한다. SNI/Host와 인증서 검증 이름은 www로 유지된다.
# Cloudflare를 거치지 않으므로 이 검사로 Full / Full (strict)의 200/526을 확인할 수는 없다.
# expected는 HTTP 상태가 아닌 curl 종료 코드다. normal은 0, mismatch는 60을 기대한다.
# 60은 인증서 검증 실패 전체를 뜻하므로 이름 불일치 원인까지 별도로 구분하지는 않는다.
expected=0
[[ "$mode" == mismatch ]] && expected=60
healthy=0
# reload 후 새 worker로 전환되는 시간을 고려해 최대 5회 시도한다.
for attempt in 1 2 3 4 5; do
  actual=0
  # 실패 코드를 직접 받으므로 의도한 curl 60에서도 set -e로 즉시 종료하지 않는다.
  # --fail은 HTTP 400 이상을 실패로 처리한다. 정확히 200만 허용하는 검사는 아니다.
  curl --fail --silent --show-error --noproxy '*' \
    --connect-timeout 2 --max-time 5 \
    --resolve www.infiniteloopclub.cloud:443:127.0.0.1 \
    -o /dev/null https://www.infiniteloopclub.cloud/headers \
    2> "$backup/probe-error.txt" || actual=$?
  if [[ "$actual" == "$expected" ]]; then
    healthy=1
    break
  fi
  sleep 1
done
if (( ! healthy )); then
  cat "$backup/probe-error.txt" >&2
  echo "Unexpected TLS probe: curl=$actual, expected=$expected" >&2
  exit 1
fi
# 9. 여기까지 통과하면 종료 시 자동 복구를 하지 않고 적용 상태를 유지한다.
# mismatch 실험을 끝낸 뒤 Actions에서 normal을 다시 실행해야 정상 인증서로 돌아간다.
complete=1
echo "Nginx deployed: mode=$mode revision=${DEPLOY_REVISION:-local}"
if [[ "$mode" == mismatch ]]; then
  echo "Intentional certificate verification failure (curl 60) confirmed."
  echo "Compare Cloudflare Full / Full (strict), then run this workflow with normal."
else
  echo "Local HTTPS certificate verification and HTTP response succeeded."
fi
