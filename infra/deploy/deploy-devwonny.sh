#!/usr/bin/env bash
# Run on EC2 via SSM. Keep the origin certificate and the existing TLS lab intact.
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_config="$script_dir/../nginx/devwonny.conf"
nginx_root=${NGINX_ROOT:-/etc/nginx}
certbot_root=${CERTBOT_ROOT:-/etc/letsencrypt}
backup_root=${BACKUP_ROOT:-/var/backups/edge-access-lab-nginx}
enabled="$nginx_root/sites-enabled/devwonny"
target="$nginx_root/sites-available/devwonny"
certificate="$certbot_root/live/devwonny.win/fullchain.pem"

test -d "$nginx_root/sites-available"
test -d "$nginx_root/sites-enabled"
test -f "$source_config"
mkdir -p "$backup_root"
# Share the same lock as the infiniteloopclub deployment script.
exec 9>"$backup_root/deploy.lock"
flock -w 30 9

enabled_existed=0
if [[ -e "$enabled" || -L "$enabled" ]]; then
    enabled_existed=1
    test -f "$enabled"
    target=$(readlink -f -- "$enabled")
fi
case "$target" in
    "$nginx_root/sites-available/devwonny"|"$enabled") ;;
    *) echo "Unexpected Nginx target: $target" >&2; exit 1 ;;
esac
# Do not follow an inactive site's unexpected symlink either.
if [[ -L "$target" ]]; then
    echo "Unexpected inactive Nginx symlink: $target" >&2
    exit 1
fi
nginx -t
curl --fail --silent --show-error --noproxy '*' --max-time 5 \
    -o /dev/null http://127.0.0.1:8080/headers

# Issue only when the new certificate is missing. Existing certificates are
# renewed by Certbot's timer. No credentials or private keys leave this server.
if [[ ! -s "$certificate" || ! -s "$certbot_root/live/devwonny.win/privkey.pem" ]]; then
    python3 - "$certbot_root" <<'PY'
import configparser
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1])
config = configparser.ConfigParser(interpolation=None)
config.read(root / "renewal/origin.devwonny.win.conf")
params = config["renewalparams"]
if params.get("authenticator") != "dns-cloudflare":
    raise SystemExit("The existing origin certificate must use dns-cloudflare")
credentials = params.get("dns_cloudflare_credentials", "")
if not credentials or not Path(credentials).is_file():
    raise SystemExit("Existing Cloudflare DNS credentials file is unavailable")
account = params.get("account", "")
server = params.get("server", "")
if not account or not server:
    raise SystemExit("Existing ACME account/server configuration is unavailable")
command = [
    "certbot", "certonly", "--non-interactive", "--dns-cloudflare",
    "--dns-cloudflare-credentials", credentials,
    "--dns-cloudflare-propagation-seconds",
    params.get("dns_cloudflare_propagation_seconds", "60"),
    "--account", account, "--server", server,
    "--cert-name", "devwonny.win",
    "-d", "devwonny.win", "-d", "www.devwonny.win",
    "--deploy-hook", "nginx -t && systemctl reload nginx",
]
subprocess.run(command, check=True, timeout=300)
PY
fi
test -s "$certificate"
test -s "$certbot_root/live/devwonny.win/privkey.pem"
openssl x509 -in "$certificate" -noout -checkend 0

backup=$(mktemp -d "$backup_root/devwonny.XXXXXXXX")
target_existed=0
if [[ -f "$target" ]]; then
    target_existed=1
    cp -p -- "$target" "$backup/previous.conf"
fi
printf 'revision=%s\ntarget=%s\nenabled_existed=%s\ntarget_existed=%s\n' \
    "${DEPLOY_REVISION:-local}" "$target" "$enabled_existed" "$target_existed" \
    > "$backup/deployment.txt"
echo "Backup: $backup"

changed=0
complete=0
cleanup() {
    result=$?
    trap - EXIT
    if (( changed && ! complete )); then
        echo "Deployment failed; restoring the previous devwonny site" >&2
        restored=1
        if (( target_existed )); then
            cp -p -- "$backup/previous.conf" "$target" || restored=0
        else
            rm -f -- "$target" || restored=0
        fi
        if (( ! enabled_existed )); then
            rm -f -- "$enabled" || restored=0
        fi
        if (( restored )) && nginx -t && systemctl reload nginx; then
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

changed=1
install -m 644 -- "$source_config" "$target"
if (( ! enabled_existed )); then
    ln -s -- "$target" "$enabled"
fi
nginx -t
systemctl reload nginx

# Verify real certificates, SNI, Host routing and the backend for BOTH names.
# Use GET: the header inspector does not implement HEAD (curl -I returns 501).
for domain in devwonny.win www.devwonny.win; do
    healthy=0
    for attempt in 1 2 3 4 5; do
        if curl --fail --silent --show-error --noproxy '*' \
            --connect-timeout 2 --max-time 5 \
            --resolve "$domain:443:127.0.0.1" \
            -o /dev/null "https://$domain/headers" 2> "$backup/probe-error.txt"; then
            healthy=1
            break
        fi
        sleep 1
    done
    if (( ! healthy )); then
        cat "$backup/probe-error.txt" >&2
        echo "Local HTTPS verification failed for $domain" >&2
        exit 1
    fi
done
complete=1
echo "Nginx deployed: site=devwonny revision=${DEPLOY_REVISION:-local}"
echo "Local HTTPS verification succeeded for devwonny.win and www.devwonny.win."
