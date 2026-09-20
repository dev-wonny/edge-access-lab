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


# 앱 전체에서 함께 사용하는 로거. 출력 위치와 형식은 configure_logging에서 정한다.
LOGGER = logging.getLogger("header_inspector")


class JsonLogFormatter(logging.Formatter):
    """로그 한 건을 서비스 식별 정보가 포함된 한 줄 JSON으로 변환한다."""
    def format(self, record):
        # HTTP 응답과 별개인 서버 로그다. message에는 기존 로그 문장을 보존한다.
        entry = {
            "service": "header-inspector",
            "runtime": "python",
            "component": "origin",
            "timestamp": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": record.levelname,
            "message": record.getMessage(),
        }
        # 예외 발생 시 호출 경로(traceback)도 기록해 원인을 추적한다.
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, ensure_ascii=False)


def configure_logging():
    """기본은 콘솔 출력이며, APP_LOG_FILE이 있으면 파일에도 같은 로그를 남긴다."""
    # INFO 이상을 기록한다. DEBUG는 생략한다.
    LOGGER.setLevel(logging.INFO)
    # 상위 로거로 다시 전달되어 중복 출력되는 것을 막는다.
    LOGGER.propagate = False
    # 초기화를 다시 호출해도 출력 대상이 중복 등록되지 않도록 정리한다.
    for handler in LOGGER.handlers[:]:
        handler.close()
        LOGGER.removeHandler(handler)
    # 로컬에서는 터미널, systemd로 실행하면 journal에 보이는 표준 출력이다.
    handlers = [logging.StreamHandler(sys.stdout)]
    # EC2 서비스 설정에서 로그 파일 경로를 환경변수로 전달한다.
    log_file = os.environ.get("APP_LOG_FILE")
    if log_file:
        # 상위 폴더는 systemd의 LogsDirectory가 만들고 앱 계정에 쓰기 권한을 준다.
        # 약 10 MiB마다 새 파일로 전환하며 이전 파일은 최대 5개 보관한다.
        # 이 파일을 읽어 AWS로 보내는 역할은 CloudWatch Agent가 맡는다.
        handlers.append(RotatingFileHandler(
            log_file, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
        ))
    # 콘솔과 파일에 동일한 JSON 형식을 적용한다. 핸들러는 기록마다 flush한다.
    for handler in handlers:
        handler.setFormatter(JsonLogFormatter())
        LOGGER.addHandler(handler)


class LoggingHTTPServer(ThreadingHTTPServer):
    """기존 다중 스레드 서버를 상속하고 요청 처리 중 예외 기록만 추가한다."""
    def handle_error(self, request, client_address):
        # 요청 스레드에서 처리되지 않은 예외가 발생하면 서버가 호출한다.
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

    # HTTP 서버가 메서드에 맞는 do_GET/do_POST 등을 호출하면 같은 함수가 실행된다.
    # /headers 전용 경로 분기는 없다. 아래 메서드는 다른 경로에서도 요청 정보를 반환한다.
    do_GET = handle_request
    do_POST = handle_request
    do_PUT = handle_request
    do_PATCH = handle_request
    do_DELETE = handle_request
    do_OPTIONS = handle_request

    def log_message(self, format, *args):
        """기존 요청 로그 순서 유지: [시간] [클라이언트 IP] [요청 내용]."""
        # 기본 log_request가 이 함수를 호출하며 요청 행, 상태 코드, 크기를 전달한다.
        # 예: "GET /headers?demo=1 HTTP/1.1" 200 -
        # IP는 직접 연결한 상대다. 같은 서버의 Nginx를 거치면 127.0.0.1이다.
        # 기존 시간은 서버 로컬 시간이고, 바깥 JSON의 timestamp는 UTC다.
        LOGGER.info(
            "[%s] [%s] [%s]",
            self.log_date_time_string(),
            self.client_address[0],
            format % args,
        )

    def log_error(self, format, *args):
        # HTTP 오류도 같은 문장 순서로 기록하되 심각도를 ERROR로 표시한다.
        LOGGER.error(
            "[%s] [%s] [%s]",
            self.log_date_time_string(),
            self.client_address[0],
            format % args,
        )


# 직접 실행할 때만 서버를 시작한다. 테스트에서 import하면 실행하지 않는다.
if __name__ == "__main__":
    # 1. 시작 메시지부터 남길 수 있도록 로깅을 먼저 준비한다.
    configure_logging()
    try:
        # 2. 기존과 같은 주소에서 다중 스레드 서버를 실행한다.
        # with 블록을 빠져나올 때 서버 소켓을 정리한다.
        with LoggingHTTPServer(("127.0.0.1", 8080), HeaderHandler) as server:
            LOGGER.info("Header inspector listening on http://127.0.0.1:8080")
            try:
                # 3. 요청을 계속 기다리고 HeaderHandler로 처리한다.
                server.serve_forever()
            except KeyboardInterrupt:
                # 터미널에서 Ctrl+C로 종료하면 남기는 메시지다.
                LOGGER.info("Header inspector stopped")
    except Exception:
        # 서버 기동/실행 실패를 기록하고 예외를 다시 발생시켜 systemd도 실패를 알게 한다.
        LOGGER.exception("server_failed")
        raise
