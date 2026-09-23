#!/usr/bin/env bash
# Run as root via SSM. normal restores the repository's canonical HTTPS config.
set -euo pipefail

mode=${1:-normal}
case "$mode" in
  normal) certificate_name=infiniteloopclub.cloud ;;
  mismatch) certificate_name=origin.devwonny.win ;;
  *) echo "Usage: $0 [normal|mismatch]" >&2; exit 2 ;;
esac

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_config="$script_dir/../nginx/infiniteloopclub.conf"
# Overrides allow isolated tests; Actions uses the production defaults.
nginx_root=${NGINX_ROOT:-/etc/nginx}
certbot_root=${CERTBOT_ROOT:-/etc/letsencrypt}
backup_root=${BACKUP_ROOT:-/var/backups/edge-access-lab-nginx}
enabled="$nginx_root/sites-enabled/infiniteloopclub"

mkdir -p "$backup_root"
exec 9>"$backup_root/deploy.lock"
flock -w 30 9

# Preserve the enabled symlink, including installations using a regular file.
test -f "$enabled"
target=$(readlink -f -- "$enabled")
case "$target" in
  "$nginx_root/sites-available/infiniteloopclub"|"$enabled") ;;
  *) echo "Unexpected Nginx target: $target" >&2; exit 1 ;;
esac
for file in fullchain.pem privkey.pem; do
  test -s "$certbot_root/live/$certificate_name/$file" || {
    echo "Missing certificate file: $certbot_root/live/$certificate_name/$file" >&2
    exit 1
  }
done
nginx -t
curl --fail --silent --show-error --noproxy '*' --max-time 5 \
  -o /dev/null http://127.0.0.1:8080/headers

backup=$(mktemp -d "$backup_root/deploy.XXXXXXXX")
cp -p -- "$target" "$backup/previous.conf"
printf 'mode=%s\nrevision=%s\ntarget=%s\n' \
  "$mode" "${DEPLOY_REVISION:-local}" "$target" > "$backup/deployment.txt"
echo "Backup: $backup"

changed=0
complete=0
cleanup() {
  result=$?
  trap - EXIT
  if (( changed && ! complete )); then
    echo "Deployment failed; restoring $backup/previous.conf" >&2
    if cp -p -- "$backup/previous.conf" "$target" && nginx -t && systemctl reload nginx; then
      echo "Previous Nginx configuration restored" >&2
    else
      echo "ROLLBACK FAILED: inspect SSM output and $backup" >&2
    fi
    result=1
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Only the test candidate changes; the repository always keeps the correct cert.
sed "s|/etc/letsencrypt/live/infiniteloopclub.cloud/|/etc/letsencrypt/live/$certificate_name/|g" \
  "$source_config" > "$backup/candidate.conf"
changed=1
install -m 644 -- "$backup/candidate.conf" "$target"
nginx -t
systemctl reload nginx

# Probe this Nginx directly, preserving SNI/Host; no public DNS or Cloudflare here.
# Reload starts new workers asynchronously, so allow a short transition.
expected=0
[[ "$mode" == mismatch ]] && expected=60
healthy=0
for attempt in 1 2 3 4 5; do
  actual=0
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
complete=1
echo "Nginx deployed: mode=$mode revision=${DEPLOY_REVISION:-local}"
if [[ "$mode" == mismatch ]]; then
  echo "Intentional certificate verification failure (curl 60) confirmed."
  echo "Compare Cloudflare Full / Full (strict), then run this workflow with normal."
else
  echo "Local HTTPS certificate verification and HTTP response succeeded."
fi
