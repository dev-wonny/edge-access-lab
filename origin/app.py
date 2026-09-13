#!/usr/bin/env python3

import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class HeaderHandler(BaseHTTPRequestHandler):
    def handle_request(self):
        payload = {
            "method": self.command,
            "path": self.path,
            "client_ip": self.client_address[0],
            "received_at": datetime.now(timezone.utc).isoformat(),
            "headers": [
                {"name": name, "value": value}
                for name, value in self.headers.items()
            ],
        }

        body = json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = handle_request
    do_POST = handle_request
    do_PUT = handle_request
    do_PATCH = handle_request
    do_DELETE = handle_request
    do_OPTIONS = handle_request

    def log_message(self, format, *args):
        print(
            f"{self.log_date_time_string()} "
            f"{self.client_address[0]} "
            f"{format % args}"
        )


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8080), HeaderHandler)
    print("Header inspector listening on http://127.0.0.1:8080")
    server.serve_forever()
