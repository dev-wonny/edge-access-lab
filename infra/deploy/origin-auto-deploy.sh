#!/usr/bin/env bash
# EC2에서 실행: main을 확인하고 테스트 후 Python 서비스만 재시작한다.
set -Eeuo pipefail
export GIT_TERMINAL_PROMPT=0
export PYTHONDONTWRITEBYTECODE=1
repo=/home/ubuntu/edge-access-lab
state=/home/ubuntu/.local/state/origin-auto-deploy
mkdir -p "$state"
exec 9>"$state/lock"
flock -n 9 || exit 0
cd "$repo"

# 수동 작업 중인 파일이나 다른 브랜치를 덮어쓰지 않는다.
[[ $(git branch --show-current) == main ]] || { echo 'main 브랜치가 아닙니다.'; exit 1; }
[[ -z $(git status --porcelain) ]] || { echo '로컬 변경이 있어 배포를 중단합니다.'; exit 1; }
old=$(git rev-parse HEAD)
timeout 60 git fetch origin main
target=$(git rev-parse refs/remotes/origin/main)
[[ "$old" != "$target" ]] || exit 0
git merge-base --is-ancestor "$old" "$target" || { echo 'fast-forward 불가: 수동 확인 필요'; exit 1; }
# 실패한 동일 버전을 매분 재배포하지 않는다. 다음 커밋 또는 수동 재시도까지 기다린다.
[[ ! -f "$state/failed" || $(cat "$state/failed") != "$target" ]] || exit 0

staging=$(mktemp -d)
updated=0
cleanup() {
  result=$?
  trap - EXIT
  rm -rf "$staging"
  if (( result != 0 )); then
    echo "$target" > "$state/failed"
    if (( updated )); then
      echo "배포 실패: $old 복구 시도"
      # --keep은 충돌하는 로컬 변경이 있으면 덮어쓰지 않고 실패한다.
      if git reset --keep "$old" && sudo -n systemctl restart header-inspector; then
        echo '이전 코드 복구 및 재시작 완료. 요청 상태를 확인하세요.'
      else
        echo '복구 실패: 즉시 서비스와 저장소 상태를 확인하세요.'
      fi
    fi
  fi
  exit "$result"
}
trap cleanup EXIT

# 실행 중인 파일을 건드리기 전에 후보 커밋을 임시 디렉터리에서 검사한다.
git archive "$target" | tar -x -C "$staging"
(cd "$staging" && timeout 120 python3 -m unittest discover -s tests -v)

restart=0
git diff --quiet "$old" "$target" -- origin || restart=1
# 테스트 중 수동 변경이 있었다면 배포하지 않는다.
[[ $(git rev-parse HEAD) == "$old" && -z $(git status --porcelain) ]]
updated=1
git merge --ff-only "$target"
if (( restart )); then
  sudo -n systemctl restart header-inspector
  # 서비스가 뜰 시간을 주면서 HTTP 성공 응답을 확인한다.
  healthy=0
  for attempt in {1..10}; do
    if curl --fail --silent --max-time 3 http://127.0.0.1:8080/headers -o /dev/null; then
      healthy=1
      break
    fi
    sleep 1
  done
  [[ "$healthy" == 1 ]]
  systemctl is-active --quiet header-inspector
fi
rm -f "$state/failed"
echo "배포 완료: $target (Python 재시작=$restart)"
