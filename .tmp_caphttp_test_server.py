import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/":
            self._send(200, {"service": "cap.http-local-test", "path": self.path})
        elif self.path == "/api/ping":
            self._send(200, {"pong": True})
        elif self.path == "/api/error":
            self._send(500, {"error": "intentional 500"})
        else:
            self._send(404, {"error": "not found", "path": self.path})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        self._send(201, {"received": raw.decode("utf-8", "replace"), "content_type": self.headers.get("Content-Type")})

    def log_message(self, *args):
        pass

HTTPServer(("127.0.0.1", 8848), H).serve_forever()