import contextlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("app", Path(__file__).parents[1] / "origin/app.py")
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class LoggingTests(unittest.TestCase):
    def tearDown(self):
        for handler in app.LOGGER.handlers[:]:
            handler.close()
            app.LOGGER.removeHandler(handler)

    def test_real_request_flushes_file_and_console_without_headers_or_query(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "app.log"
            console = io.StringIO()
            with patch.dict(os.environ, {"APP_LOG_FILE": str(path)}), contextlib.redirect_stdout(console):
                app.configure_logging()
                server = app.LoggingHTTPServer(("127.0.0.1", 0), app.HeaderHandler)
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                try:
                    conn = http.client.HTTPConnection(*server.server_address, timeout=3)
                    conn.request("GET", "/headers?secret=query-secret",
                                 headers={"Authorization": "Bearer header-secret"})
                    response = conn.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.loads(response.read())["path"], "/headers?secret=query-secret")
                    conn.close()
                    records = [json.loads(line) for line in path.read_text().splitlines()]
                    self.assertIn("path=/headers status=200", records[-1]["message"])
                    self.assertIn("request peer=", console.getvalue())
                    self.assertNotIn("query-secret", path.read_text())
                    self.assertNotIn("header-secret", path.read_text())
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join()

    def test_rotation_retains_bounded_backups_and_exception_is_one_json_line(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "app.log"
            with patch.dict(os.environ, {"APP_LOG_FILE": str(path)}), contextlib.redirect_stdout(io.StringIO()):
                app.configure_logging()
                handler = next(h for h in app.LOGGER.handlers if isinstance(h, app.RotatingFileHandler))
                handler.maxBytes = 512
                for _ in range(30):
                    app.LOGGER.info("rotation-test %s", "x" * 100)
                try:
                    raise RuntimeError("test failure")
                except RuntimeError:
                    app.LOGGER.exception("request_failed")
                self.assertEqual(len(list(Path(directory).glob("app.log.*"))), 5)
                record = json.loads(path.read_text().splitlines()[-1])
                self.assertEqual(record["level"], "ERROR")
                self.assertIn("RuntimeError: test failure", record["exception"])

    def test_local_mode_does_not_require_log_directory(self):
        with patch.dict(os.environ, {"APP_LOG_FILE": ""}), contextlib.redirect_stdout(io.StringIO()):
            app.configure_logging()
            self.assertEqual(len(app.LOGGER.handlers), 1)


if __name__ == "__main__":
    unittest.main()
