"""실제 HTTP 응답으로 공개 캐시와 사용자별 응답의 경계를 검사한다."""
import http.client
import threading
import unittest
from unittest.mock import patch
from test_origin_logging import app


class CdnDemoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = app.LoggingHTTPServer(("127.0.0.1", 0), app.HeaderHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, method, path, headers=None):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            conn.request(method, path, headers=headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def test_public_image_is_fixed_and_head_has_no_body(self):
        status, headers, body = self.request("GET", "/cdn-demo/cache-v1.svg?demo=1", {"Cookie": "secret=value"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/svg+xml")
        self.assertEqual(headers["Cache-Control"], "public, max-age=60, s-maxage=300")
        self.assertIn(b"<svg", body)
        self.assertNotIn(b"secret", body)
        self.assertNotIn("Set-Cookie", headers)
        status, head, empty = self.request("HEAD", "/cdn-demo/cache-v1.svg")
        self.assertEqual(status, 200)
        self.assertEqual(empty, b"")
        self.assertEqual(int(head["Content-Length"]), len(body))

    def test_unknown_and_traversal_paths_are_not_cacheable(self):
        for path in ("/cdn-demo/", "/cdn-demo/missing.svg", "/cdn-demo/../app.py", "/cdn-demo/%2e%2e/app.py"):
            with self.subTest(path=path):
                status, headers, _ = self.request("GET", path)
                self.assertEqual(status, 404)
                self.assertEqual(headers["Cache-Control"], "no-store")

    def test_post_is_rejected_and_missing_file_is_not_cached(self):
        status, headers, _ = self.request("POST", "/cdn-demo/cache-v1.svg")
        self.assertEqual(status, 405)
        self.assertEqual(headers["Allow"], "GET, HEAD")
        self.assertEqual(headers["Cache-Control"], "no-store")
        with patch.object(app.Path, "read_bytes", side_effect=OSError("missing")), self.assertLogs(app.LOGGER, level="ERROR"):
            status, headers, _ = self.request("GET", "/cdn-demo/cache-v1.svg")
        self.assertEqual(status, 503)
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_header_echo_even_with_image_extension_is_private(self):
        for path in ("/headers", "/headers.png", "/secure/TT"):
            status, headers, body = self.request("GET", path, {"Authorization": "Bearer demo"})
            self.assertEqual(status, 200)
            self.assertEqual(headers["Cache-Control"], "private, no-store")
            self.assertIn(b"Bearer demo", body)
