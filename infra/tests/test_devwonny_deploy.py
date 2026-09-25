"""Run the root/www deployment against isolated files and fake external tools."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "infra/deploy/deploy-devwonny.sh"
CONFIG = REPO / "infra/nginx/devwonny.conf"
PREVIOUS = "# previous devwonny configuration\n"
FAKE_COMMAND = r'''#!/usr/bin/env python3
import os
from pathlib import Path
import sys

name = Path(sys.argv[0]).name
if name in {"flock", "sleep"}:
    sys.exit(0)
root = Path(os.environ["NGINX_ROOT"])
enabled = root / "sites-enabled/devwonny"
config = enabled.read_text() if enabled.exists() else ""
with Path(os.environ["EVENTS"]).open("a") as out:
    out.write(name + " " + " ".join(sys.argv[1:]) + "\n")
if name == "certbot":
    if os.environ.get("FAIL_ISSUE"):
        sys.exit(1)
    folder = Path(os.environ["CERTBOT_ROOT"]) / "live/devwonny.win"
    folder.mkdir(parents=True, exist_ok=True)
    for filename in ("fullchain.pem", "privkey.pem"):
        (folder / filename).write_text("test fixture, not a real certificate")
elif name == "openssl":
    if os.environ.get("FAIL_CERT"):
        sys.exit(1)
elif name == "nginx":
    if os.environ.get("FAIL_SYNTAX") and "ssl_certificate " in config:
        sys.exit(1)
elif name == "systemctl":
    marker = root / "reload-failed"
    if os.environ.get("FAIL_RELOAD") and not marker.exists():
        marker.touch()
        sys.exit(1)
elif name == "curl":
    urls = [arg for arg in sys.argv if arg.startswith("https://")]
    if urls:
        if os.environ.get("FAIL_HOST") == urls[0].split("/")[2]:
            sys.exit(60)
    elif os.environ.get("FAIL_BACKEND"):
        sys.exit(22)
'''


class DevwonnyDeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.nginx = self.root / "nginx"
        self.available = self.nginx / "sites-available/devwonny"
        self.enabled = self.nginx / "sites-enabled/devwonny"
        self.available.parent.mkdir(parents=True)
        self.enabled.parent.mkdir()
        self.other_sites = []
        for name in ("edge-access-lab", "infiniteloopclub"):
            path = self.available.parent / name
            path.write_text(f"# existing {name}\n")
            (self.enabled.parent / name).symlink_to(path)
            self.other_sites.append((path, path.read_text()))
        self.certificates = self.root / "certbot"
        renewal = self.certificates / "renewal"
        renewal.mkdir(parents=True)
        self.credentials = self.root / "cloudflare.ini"
        self.credentials.write_text("test fixture; no credentials")
        self.renewal = renewal / "origin.devwonny.win.conf"
        self.renewal.write_text(
            "# Existing Certbot ConfigObj file, including top-level metadata\n"
            "version = 2.9.0\narchive_dir = /etc/letsencrypt/archive/origin.devwonny.win\n"
            "cert = /etc/letsencrypt/live/origin.devwonny.win/cert.pem\n"
            "\n[renewalparams]\nauthenticator = dns-cloudflare\n"
            f"dns_cloudflare_credentials = {self.credentials}\n"
            "dns_cloudflare_propagation_seconds = 60\n"
            "account = test-account\nserver = https://acme.example/directory\n"
        )
        self.backups = self.root / "backups"
        self.events = self.root / "events"
        binaries = self.root / "bin"
        binaries.mkdir()
        for name in ("nginx", "systemctl", "curl", "certbot", "openssl", "flock", "sleep"):
            path = binaries / name
            path.write_text(FAKE_COMMAND)
            path.chmod(0o755)
        self.env = dict(os.environ, NGINX_ROOT=str(self.nginx),
                        CERTBOT_ROOT=str(self.certificates),
                        BACKUP_ROOT=str(self.backups), EVENTS=str(self.events),
                        DEPLOY_REVISION="test-revision",
                        PATH=f"{binaries}:{os.environ['PATH']}")

    def deploy(self, **overrides):
        return subprocess.run(["bash", str(SCRIPT)], env=dict(self.env, **overrides),
                              capture_output=True, text=True, timeout=15)

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def assert_other_sites_unchanged(self):
        for path, content in self.other_sites:
            self.assertEqual(path.read_text(), content)
            self.assertTrue((self.enabled.parent / path.name).is_symlink())

    def existing_site(self):
        self.available.write_text(PREVIOUS)
        self.enabled.symlink_to(self.available)

    def test_first_deploy_issues_dns_certificate_and_probes_both_names(self):
        self.assert_success(self.deploy())
        self.assertTrue(self.enabled.is_symlink())
        self.assertEqual(self.enabled.read_text(), CONFIG.read_text())
        events = self.events.read_text()
        self.assertIn("--dns-cloudflare --dns-cloudflare-credentials", events)
        self.assertIn("--account test-account --server https://acme.example/directory", events)
        self.assertIn("--cert-name devwonny.win -d devwonny.win -d www.devwonny.win", events)
        self.assertIn("--deploy-hook nginx -t && systemctl reload nginx", events)
        for host in ("devwonny.win", "www.devwonny.win"):
            self.assertIn(f"--resolve {host}:443:127.0.0.1", events)
        self.assertNotIn("--insecure", events)
        self.assertNotIn("--head", events)
        self.assert_other_sites_unchanged()

    def test_redeploy_reuses_certificate_and_backs_up_active_site(self):
        self.assert_success(self.deploy())
        self.available.write_text(PREVIOUS)
        self.assert_success(self.deploy())
        self.assertEqual(self.events.read_text().count("certbot certonly"), 1)
        backups = list(self.backups.glob("devwonny.*/previous.conf"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), PREVIOUS)

    def test_enrollment_failure_does_not_install_site(self):
        result = self.deploy(FAIL_ISSUE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.enabled.exists())
        self.assertFalse(self.available.exists())
        self.assert_other_sites_unchanged()

    def test_wrong_authenticator_does_not_invoke_certbot(self):
        self.renewal.write_text(self.renewal.read_text().replace("dns-cloudflare", "nginx"))
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("certbot certonly", self.events.read_text())
        self.assertFalse(self.enabled.exists())

    def test_missing_credentials_does_not_install_site(self):
        self.credentials.unlink()
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("certbot certonly", self.events.read_text())
        self.assertFalse(self.enabled.exists())

    def test_invalid_certificate_stops_before_config_change(self):
        self.existing_site()
        result = self.deploy(FAIL_CERT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.enabled.read_text(), PREVIOUS)

    def test_syntax_failure_removes_new_site(self):
        result = self.deploy(FAIL_SYNTAX="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Previous Nginx configuration restored", result.stderr)
        self.assertFalse(self.enabled.is_symlink())
        self.assertFalse(self.available.exists())
        self.assert_other_sites_unchanged()

    def test_syntax_failure_restores_existing_site_and_link(self):
        self.existing_site()
        result = self.deploy(FAIL_SYNTAX="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.enabled.read_text(), PREVIOUS)
        self.assertTrue(self.enabled.is_symlink())
        self.assert_other_sites_unchanged()

    def test_www_certificate_failure_rolls_back_even_if_root_succeeds(self):
        result = self.deploy(FAIL_HOST="www.devwonny.win")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Local HTTPS verification failed for www.devwonny.win", result.stderr)
        self.assertIn("https://devwonny.win/headers", self.events.read_text())
        self.assertFalse(self.enabled.is_symlink())
        self.assertFalse(self.available.exists())
        self.assert_other_sites_unchanged()

    def test_reload_failure_restores_previous_site(self):
        self.existing_site()
        result = self.deploy(FAIL_RELOAD="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.enabled.read_text(), PREVIOUS)
        self.assertEqual(self.events.read_text().splitlines().count("systemctl reload nginx"), 2)

    def test_backend_failure_stops_before_enrollment(self):
        result = self.deploy(FAIL_BACKEND="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("certbot certonly", self.events.read_text())
        self.assertFalse(self.enabled.exists())

    def test_unexpected_enabled_symlink_is_rejected(self):
        self.enabled.symlink_to(self.other_sites[0][0])
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unexpected Nginx target", result.stderr)
        self.assert_other_sites_unchanged()

    def test_unexpected_inactive_symlink_is_rejected(self):
        self.available.symlink_to(self.other_sites[0][0])
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assert_other_sites_unchanged()

    def test_regular_enabled_file_is_supported(self):
        self.enabled.write_text(PREVIOUS)
        self.assert_success(self.deploy())
        self.assertFalse(self.enabled.is_symlink())
        self.assertEqual(self.enabled.read_text(), CONFIG.read_text())


if __name__ == "__main__":
    unittest.main()
