"""Exercise the real deployment script with isolated paths and fake system commands.

These tests cover deployment/rollback, not live Nginx, AWS or Cloudflare.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "infra/deploy/deploy-nginx.sh"
CONFIG = REPO / "infra/nginx/infiniteloopclub.conf"
PREVIOUS = "# previous live config, including manual changes\n"

FAKE_COMMAND = r'''#!/usr/bin/env python3
import os
from pathlib import Path
import sys

name = Path(sys.argv[0]).name
root = Path(os.environ["NGINX_ROOT"])
config = (root / "sites-enabled/infiniteloopclub").read_text()
events = Path(os.environ["EVENTS"])
with events.open("a") as out:
    out.write(name + " " + " ".join(sys.argv[1:]) + "\n")

if name == "nginx":
    if os.environ.get("FAIL_SYNTAX") and "ssl_certificate " in config:
        sys.exit(1)
elif name == "systemctl":
    marker = root / "reload-failed"
    if os.environ.get("FAIL_RELOAD") and not marker.exists():
        marker.touch()
        sys.exit(1)
elif name == "curl":
    if any(arg.startswith("https://") for arg in sys.argv):
        if os.environ.get("FAIL_HTTPS"):
            sys.exit(7)
        if "/live/origin.devwonny.win/" in config:
            sys.exit(60)
    elif os.environ.get("FAIL_BACKEND"):
        sys.exit(22)
'''


class NginxDeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.nginx = self.root / "nginx"
        self.available = self.nginx / "sites-available/infiniteloopclub"
        self.enabled = self.nginx / "sites-enabled/infiniteloopclub"
        self.available.parent.mkdir(parents=True)
        self.enabled.parent.mkdir()
        self.available.write_text(PREVIOUS)
        self.enabled.symlink_to(self.available)
        self.certificates = self.root / "certbot"
        for domain in ("infiniteloopclub.cloud", "origin.devwonny.win"):
            folder = self.certificates / "live" / domain
            folder.mkdir(parents=True)
            for name in ("fullchain.pem", "privkey.pem"):
                (folder / name).write_text("test fixture, not a real certificate")
        self.backups = self.root / "backups"
        self.events = self.root / "events"
        binaries = self.root / "bin"
        binaries.mkdir()
        for name in ("nginx", "systemctl", "curl", "sleep"):
            file = binaries / name
            file.write_text(FAKE_COMMAND)
            file.chmod(0o755)
        self.env = dict(os.environ, NGINX_ROOT=str(self.nginx),
                        CERTBOT_ROOT=str(self.certificates),
                        BACKUP_ROOT=str(self.backups), EVENTS=str(self.events),
                        DEPLOY_REVISION="test-revision",
                        PATH=f"{binaries}:{os.environ['PATH']}")

    def deploy(self, mode="normal", **overrides):
        return subprocess.run(["bash", str(SCRIPT), mode],
                              env=dict(self.env, **overrides),
                              capture_output=True, text=True, timeout=15)

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def assert_restored(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.enabled.read_text(), PREVIOUS)
        self.assertIn("Previous Nginx configuration restored", result.stderr)
        self.assertTrue(self.enabled.is_symlink())

    def test_normal_preserves_link_and_backs_up_previous_config(self):
        self.assert_success(self.deploy())
        self.assertTrue(self.enabled.is_symlink())
        self.assertEqual(self.available.read_text(), CONFIG.read_text())
        backups = list(self.backups.glob("deploy.*/previous.conf"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), PREVIOUS)
        self.assertIn("revision=test-revision", backups[0].with_name("deployment.txt").read_text())

    def test_mismatch_then_normal_restores_correct_certificate(self):
        self.assert_success(self.deploy("mismatch"))
        self.assertIn("/live/origin.devwonny.win/fullchain.pem", self.enabled.read_text())
        self.assertNotIn("/live/infiniteloopclub.cloud/", self.enabled.read_text())
        self.assert_success(self.deploy("normal"))
        self.assertEqual(self.enabled.read_text(), CONFIG.read_text())

    def test_regular_enabled_file_is_supported(self):
        self.enabled.unlink()
        self.enabled.write_text(PREVIOUS)
        self.assert_success(self.deploy())
        self.assertFalse(self.enabled.is_symlink())

    def test_missing_certificate_does_not_change_live_config(self):
        (self.certificates / "live/origin.devwonny.win/privkey.pem").unlink()
        result = self.deploy("mismatch")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.enabled.read_text(), PREVIOUS)
        self.assertFalse(self.events.exists())

    def test_invalid_candidate_rolls_back_before_reloading(self):
        self.assert_restored(self.deploy(FAIL_SYNTAX="1"))
        # The only reload activates the restored configuration.
        self.assertEqual(self.events.read_text().count("systemctl reload nginx"), 1)

    def test_reload_failure_restores_and_reloads_previous_config(self):
        self.assert_restored(self.deploy(FAIL_RELOAD="1"))
        self.assertEqual(self.events.read_text().count("systemctl reload nginx"), 2)

    def test_unreachable_https_is_not_accepted_as_expected_mismatch(self):
        result = self.deploy("mismatch", FAIL_HTTPS="1")
        self.assert_restored(result)
        self.assertIn("curl=7, expected=60", result.stderr)

    def test_backend_failure_stops_before_changing_config(self):
        result = self.deploy(FAIL_BACKEND="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.enabled.read_text(), PREVIOUS)
        self.assertNotIn("systemctl", self.events.read_text())

    def test_invalid_mode_does_not_touch_config(self):
        result = self.deploy("anything-else")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.enabled.read_text(), PREVIOUS)
        self.assertFalse(self.backups.exists())

    def test_unexpected_symlink_target_is_rejected(self):
        unrelated = self.nginx / "sites-available/other-site"
        unrelated.write_text(PREVIOUS)
        self.enabled.unlink()
        self.enabled.symlink_to(unrelated)
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(unrelated.read_text(), PREVIOUS)
        self.assertIn("Unexpected Nginx target", result.stderr)


if __name__ == "__main__":
    unittest.main()
