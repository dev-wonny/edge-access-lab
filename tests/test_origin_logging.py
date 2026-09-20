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

# 실제 서버를 실행하는 대신 모듈로 불러와 로깅 설정과 서버 클래스를 테스트한다.
spec = importlib.util.spec_from_file_location("app", Path(__file__).parents[1] / "origin/app.py")
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class LoggingTests(unittest.TestCase):
    def tearDown(self):
        # 테스트마다 파일을 닫고 핸들러를 제거해 다음 테스트에 설정이 남지 않게 한다.
        for handler in app.LOGGER.handlers[:]:
            handler.close()
            app.LOGGER.removeHandler(handler)

    def test_real_request_preserves_time_ip_request_in_file_and_console(self):
        # 임시 폴더와 메모리 출력 버퍼를 사용하므로 운영 로그 파일은 건드리지 않는다.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "app.log"
            console = io.StringIO()
            with patch.dict(os.environ, {"APP_LOG_FILE": str(path)}), contextlib.redirect_stdout(console):
                app.configure_logging()
                # 포트 0은 운영체제가 빈 포트를 고르게 한다. 별도 스레드에서 요청을 받는다.
                server = app.LoggingHTTPServer(("127.0.0.1", 0), app.HeaderHandler)
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                try:
                    # 실제 HTTP 요청을 보내 쿼리 문자열과 테스트용 인증 헤더를 전달한다.
                    conn = http.client.HTTPConnection(*server.server_address, timeout=3)
                    conn.request("GET", "/headers?demo=1",
                                 headers={"Authorization": "Bearer header-secret"})
                    response = conn.getresponse()
                    # 로깅을 추가해도 응답 상태와 요청 경로가 유지되는지 확인한다.
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.loads(response.read())["path"], "/headers?demo=1")
                    conn.close()
                    records = [json.loads(line) for line in path.read_text().splitlines()]
                    # 요청 로그의 [시간] [클라이언트 IP] [요청 내용] 형식을 확인한다.
                    self.assertRegex(records[-1]["message"], r'^\[.+\] \[127\.0\.0\.1\] \["GET /headers\?demo=1 HTTP/1\.1" 200 -\]$')
                    # 어떤 서비스와 실행 환경에서 나온 로그인지 구분할 수 있어야 한다.
                    self.assertEqual(records[-1]["service"], "header-inspector")
                    self.assertEqual(records[-1]["runtime"], "python")
                    self.assertEqual(records[-1]["component"], "origin")
                    # 콘솔과 파일의 메시지는 같아야 하며, 쿼리 문자열도 유지한다.
                    self.assertEqual(json.loads(console.getvalue().splitlines()[-1])["message"], records[-1]["message"])
                    self.assertIn("/headers?demo=1", records[-1]["message"])
                    # 요청 내용은 기록하지만 테스트용 인증 헤더 값은 파일에 남기지 않는다.
                    self.assertNotIn("header-secret", path.read_text())
                finally:
                    # 검증에 실패해도 서버와 스레드를 정리해 테스트가 멈추지 않게 한다.
                    server.shutdown()
                    server.server_close()
                    thread.join()

    def test_rotation_retains_bounded_backups_and_exception_is_one_json_line(self):
        # 로그 파일 순환 보관과 예외 로그의 한 줄 JSON 형식을 검증한다.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "app.log"
            with patch.dict(os.environ, {"APP_LOG_FILE": str(path)}), contextlib.redirect_stdout(io.StringIO()):
                app.configure_logging()
                handler = next(h for h in app.LOGGER.handlers if isinstance(h, app.RotatingFileHandler))
                # 작은 용량으로 낮춰 파일 교체를 빠르게 유도한다. 운영 설정은 바꾸지 않는다.
                handler.maxBytes = 512
                for _ in range(30):
                    app.LOGGER.info("rotation-test %s", "x" * 100)
                # 의도적으로 예외를 발생시켜 오류 수준과 예외 내용이 함께 기록되는지 확인한다.
                try:
                    raise RuntimeError("test failure")
                except RuntimeError:
                    app.LOGGER.exception("request_failed")
                # 오래된 파일은 정리되고 백업은 5개만 남아야 한다.
                self.assertEqual(len(list(Path(directory).glob("app.log.*"))), 5)
                # 마지막 물리적 한 줄을 JSON으로 읽을 수 있어야 한다.
                record = json.loads(path.read_text().splitlines()[-1])
                self.assertEqual(record["level"], "ERROR")
                self.assertEqual(record["runtime"], "python")
                self.assertEqual(record["service"], "header-inspector")
                self.assertIn("RuntimeError: test failure", record["exception"])

    def test_local_mode_does_not_require_log_directory(self):
        # 파일 경로가 없으면 콘솔 핸들러 하나만 사용해 로컬에서도 실행할 수 있어야 한다.
        with patch.dict(os.environ, {"APP_LOG_FILE": ""}), contextlib.redirect_stdout(io.StringIO()):
            app.configure_logging()
            self.assertEqual(len(app.LOGGER.handlers), 1)


# 이 파일을 직접 실행하면 위의 테스트를 실행한다.
if __name__ == "__main__":
    unittest.main()
