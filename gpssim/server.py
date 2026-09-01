"""餵測試頁的本機 HTTP server。

**不能用 `file://`**（計畫 §11）：Geolocation 只在 secure context 下可用，
而 `file://` 不算。`http://127.0.0.1` 算——loopback 位址被規格列為
potentially trustworthy，所以不需要憑證也不需要 HTTPS。
"""

import functools
import os
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler

PAGE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testpage")


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass   # 每個請求印一行只會蓋掉驗證輸出


class TestPageServer:
    def __init__(self, directory=PAGE_DIR, port=0):
        handler = functools.partial(_QuietHandler, directory=directory)
        self.httpd = HTTPServer(("127.0.0.1", port), handler)
        self.port = self.httpd.server_address[1]
        self._thread = None

    @property
    def origin(self):
        return f"http://127.0.0.1:{self.port}"

    @property
    def url(self):
        return f"{self.origin}/location-test.html"

    @property
    def route_url(self):
        return f"{self.origin}/route-test.html"

    def start(self):
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()
