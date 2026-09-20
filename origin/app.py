#!/usr/bin/env python3
"""
오리진 테스트 서버 (Header Inspector)
- 클라이언트로부터 들어온 HTTP 요청의 메서드, 경로, IP, 헤더 목록을 JSON 형태로 반환합니다.
- Cloudflare Access, 프록시, CDN 등을 거쳐 전달되는 헤더를 검증할 때 사용됩니다.
"""

import json
import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


LOGGER = logging.getLogger("header_inspector")


class JsonLogFormatter(logging.Formatter):
    def format(self, record):
        entry = {
            "timestamp": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": record.levelname,
            "message": record.getMessage(),
        }
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, ensure_ascii=False)


def configure_logging():
    """Console locally; console + rotating file when APP_LOG_FILE is set."""
    LOGGER.setLevel(logging.INFO)
    LOGGER.propagate = False
    for handler in LOGGER.handlers[:]:
        handler.close()
        LOGGER.removeHandler(handler)
    handlers = [logging.StreamHandler(sys.stdout)]
    log_file = os.environ.get("APP_LOG_FILE")
    if log_file:
        # Parent directory is provisioned by systemd LogsDirectory.
        handlers.append(RotatingFileHandler(
            log_file, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
        ))
    for handler in handlers:
        handler.setFormatter(JsonLogFormatter())
        LOGGER.addHandler(handler)


class LoggingHTTPServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        LOGGER.exception("request_failed peer=%s", client_address[0])


class HeaderHandler(BaseHTTPRequestHandler):
    """
    모든 HTTP 요청을 수신하여 요청 정보 및 헤더를 JSON으로 응답하는 핸들러 클래스
    """

    def handle_request(self):
        # 1. 요청 메타데이터 및 헤더 목록 추출
        payload = {
            "method": self.command,  # HTTP 메서드 (GET, POST 등)
            "path": self.path,  # 요청 URL 경로 및 쿼리스트링
            "client_ip": self.client_address[0],  # 직전 연결 클라이언트(또는 프록시)의 IP
            "received_at": datetime.now(timezone.utc).isoformat(),  # UTC 기준 요청 수신 시각
            "headers": [
                {"name": name, "value": value}
                for name, value in self.headers.items()
            ],  # 수신된 모든 HTTP 요청 헤더 목록
        }

        # 2. 딕셔너리를 JSON 문자열로 직렬화 후 UTF-8 바이트로 인코딩
        body = json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")

        # 3. HTTP 응답 헤더 전송 (200 OK, JSON Content-Type)
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()

        # 4. JSON 바디 응답 전송
        self.wfile.write(body)

    # 모든 주요 HTTP 메서드 요청을 동일한 handle_request 메서드로 라우팅
    do_GET = handle_request
    do_POST = handle_request
    do_PUT = handle_request
    do_PATCH = handle_request
    do_DELETE = handle_request
    do_OPTIONS = handle_request

    def log_request(self, code="-", size="-"):
        # Keep headers and query strings out of persistent request logs.
        LOGGER.info(
            "request peer=%s method=%s path=%s status=%s size=%s",
            self.client_address[0], self.command,
            getattr(self, "path", "").split("?", 1)[0], code, size,
        )

    def log_message(self, format, *args):
        LOGGER.info("http peer=%s %s", self.client_address[0], format % args)

    def log_error(self, format, *args):
        # Parser diagnostics may contain raw request lines or secrets.
        LOGGER.error("http_error peer=%s", self.client_address[0])


if __name__ == "__main__":
    configure_logging()
    try:
        with LoggingHTTPServer(("127.0.0.1", 8080), HeaderHandler) as server:
            LOGGER.info("Header inspector listening on http://127.0.0.1:8080")
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                LOGGER.info("Header inspector stopped")
    except Exception:
        LOGGER.exception("server_failed")
        raise
