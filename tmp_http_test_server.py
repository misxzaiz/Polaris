import json
from http.server import BaseHTTPRequestHandler, HTTPServer
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18999


class Handler(BaseHTTPRequestHandler):
    def _reply(self, code=200):
        body = {
            "method": self.command,
            "path": self.path,
            "message": "hello from local test server",
        }
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._reply()

    def log_message(self, fmt, *args):
        print(f"[server] {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"listening on 0.0.0.0:{PORT}", flush=True)
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()