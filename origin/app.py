#!/usr/bin/env python3
"""
오리진 테스트 서버 (Header Inspector)
- 클라이언트로부터 들어온 HTTP 요청의 메서드, 경로, IP, 헤더 목록을 JSON 형태로 반환합니다.
- Cloudflare Access, 프록시, CDN 등을 거쳐 전달되는 헤더를 검증할 때 사용됩니다.
"""

import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


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

    def log_message(self, format, *args):
        """
        서버 표준 출력 로그 포맷 커스텀: [시간] [클라이언트 IP] [요청 내용]
        """
        print(
            f"{self.log_date_time_string()} "
            f"{self.client_address[0]} "
            f"{format % args}"
        )


if __name__ == "__main__":
    # 다중 스레드를 지원하는 HTTP 서버 인스턴스 생성 (127.0.0.1:8080)
    server = ThreadingHTTPServer(("127.0.0.1", 8080), HeaderHandler)
    print("Header inspector listening on http://127.0.0.1:8080")
    
    # 서버 실행 (종료 시그널 수신 전까지 무한 대기)
    server.serve_forever()

