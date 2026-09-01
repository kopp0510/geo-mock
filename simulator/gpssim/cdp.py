"""極簡 Chrome DevTools Protocol client。

CDP 是 JSON-RPC 2.0 風味的協定跑在一條 WebSocket 上：送 `{id, method, params}`，
回 `{id, result}` 或 `{id, error}`；沒有 id 的訊息是事件。
帶 `sessionId` 就是「這則指令給那個 target」。

刻意不用 puppeteer / playwright：計畫 §4 要的是「瀏覽器提供的官方機制」，
這裡直接講 CDP，中間不多一層框架。
"""

import json
import threading
import time
import urllib.request

import websocket


class CDPError(RuntimeError):
    pass


class CDP:
    def __init__(self, ws_url, timeout=60):
        # suppress_origin 是必要的，不是調校：websocket-client 預設會送 Origin header，
        # 而 Chrome 會回 403「Rejected an incoming WebSocket connection from the ... origin」。
        # 另一條路是啟動時加 --remote-allow-origins=*，但那等於對所有網頁開放 CDP，
        # 不送 Origin 乾淨得多。
        self.ws = websocket.create_connection(ws_url, timeout=timeout, suppress_origin=True)
        self._id = 0
        self._handlers = {}
        # 一條 WebSocket 同時被兩個執行緒用會壞掉：send 是「寫出去、讀到自己的
        # id 為止」，兩邊交錯的話 A 會讀走 B 在等的回覆再丟掉，B 就永遠等不到。
        # 路線播放正是這個情境 —— player 執行緒每秒送位置，驗證這端同時讀軌跡。
        self._lock = threading.RLock()
        self.browser = ""   # 由 connect() 從 /json/version 填入

    @classmethod
    def connect(cls, port, timeout=60):
        """從 DevTools HTTP 端點拿 browser 層的 WebSocket URL 再接上去。"""
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=10) as r:
            info = json.load(r)
        client = cls(info["webSocketDebuggerUrl"], timeout=timeout)
        client.browser = info.get("Browser", "")
        return client

    def on(self, method, handler):
        """註冊事件處理器。同一個 method 可掛多個。"""
        self._handlers.setdefault(method, []).append(handler)

    def send(self, method, params=None, session_id=None):
        with self._lock:
            self._id += 1
            message = {"id": self._id, "method": method, "params": params or {}}
            if session_id:
                message["sessionId"] = session_id
            self.ws.send(json.dumps(message))
            return self._wait_for(message["id"], method)

    def pump(self, seconds):
        """在沒有指令要送的時候把累積的事件讀出來派送。

        auto-attach 的 `Target.attachedToTarget` 多半在導頁之後才到，
        不主動抽的話就永遠卡在 socket 緩衝區裡。
        """
        deadline = time.time() + seconds
        original = self.ws.gettimeout()
        self._lock.acquire()
        try:
            while True:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return
                self.ws.settimeout(remaining)
                try:
                    self._dispatch(json.loads(self.ws.recv()))
                except websocket.WebSocketTimeoutException:
                    return
        finally:
            self.ws.settimeout(original)
            self._lock.release()

    def close(self):
        try:
            self.ws.close()
        except OSError:
            pass

    def _wait_for(self, message_id, method):
        while True:
            raw = json.loads(self.ws.recv())
            if raw.get("id") == message_id:
                if "error" in raw:
                    raise CDPError(f"{method} -> {raw['error']}")
                return raw.get("result", {})
            self._dispatch(raw)

    def _dispatch(self, raw):
        if "id" in raw:
            # 到得了這裡就代表有人在事件處理器裡送了指令（重入），把別人在等的
            # 回覆吃掉了。這種錯的症狀是遠處某個 send 莫名逾時，極難歸因，
            # 所以寧可吵一點。事件處理器只能排隊，不能送指令。
            raise CDPError(f"收到不屬於當前等待的回覆 id={raw['id']}；事件處理器裡不可送指令")
        for handler in self._handlers.get(raw.get("method"), []):
            handler(raw.get("params", {}), raw.get("sessionId"))
