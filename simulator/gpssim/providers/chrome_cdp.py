"""Browser-level provider：CDP 的 Emulation.setGeolocationOverride。

這是 DevTools「Sensors → Location」面板背後的同一支命令。覆寫發生在 Blink 內部，
所以頁面的 JS 看不出來、也繞不過去——與 geo-mock 擴充在頁面裡改
`navigator.geolocation` 的做法有本質差別（計畫 §8）。
"""

import base64
import sys

from ..cdp import CDP, CDPError
from ..chrome import Chrome, ChromeLaunchError
from .. import detect
from .base import LocationProvider, Support


class ChromeCdpProvider(LocationProvider):
    name = "CDP Emulation.setGeolocationOverride"
    layer = "browser"

    def __init__(self, executable=None):
        self.executable = executable
        self.chrome = None
        self.cdp = None
        self.coords = None
        # targetId -> sessionId。**用 target 而不是 session 當 key**：
        # 同一個分頁會被 attach 好幾次（我們自己 attachToTarget 一次，auto-attach
        # 還會再給幾個），每個 sessionId 都不同但指向同一個分頁。以 session 去重的話
        # 同一頁會被重覆套 override，而每次重套 Chrome 都會先對 watchPosition
        # 發一次 POSITION_UNAVAILABLE 再發新位置 —— 軌跡裡就多出一堆假錯誤。
        self._targets = {}
        self._pending = []
        self._granted = set()

    # ---- capability ----------------------------------------------------

    def is_supported(self):
        path = self.executable or detect.find_chrome()
        if not path:
            return Support(False, "找不到 Chrome。設 CHROME_BIN 或安裝 Google Chrome。")
        version = detect.chrome_version(path)
        if not version:
            return Support(False, f"Chrome 在 {path}，但問不到版本，無法確認可用。")
        return Support(True, version)

    # ---- 生命週期 ------------------------------------------------------

    def start(self, lat, lng, accuracy=10):
        support = self.is_supported()
        if not support:
            raise ChromeLaunchError(support.reason)

        self.coords = (lat, lng, accuracy)
        self.chrome = Chrome(self.executable).start()
        self.cdp = CDP.connect(self.chrome.port)

        # auto-attach 只是讓我們「看得到」新 target，**不會**把既有的 override
        # 帶過去。實測：第二個分頁沒補送就拿到真實位置。所以每個新 session 都要補。
        self.cdp.on("Target.attachedToTarget", self._on_attached)
        self.cdp.send("Target.setAutoAttach", {
            "autoAttach": True,
            "waitForDebuggerOnStart": False,
            "flatten": True,
        })
        return self

    def stop(self):
        """還原環境（計畫 §13）。

        獨立 profile 整個刪掉之後其實不會有殘留，但仍然明確地清一次 ——
        provider 若哪天改成附接既有瀏覽器，這裡就是唯一的還原點。
        """
        if self.cdp:
            for session in self._targets.values():
                try:
                    self.cdp.send("Emulation.clearGeolocationOverride", session_id=session)
                except Exception:
                    pass   # 分頁可能已經關掉了，清不掉不是錯誤
            try:
                self.cdp.send("Browser.resetPermissions")
            except Exception:
                pass
            self.cdp.close()
            self.cdp = None
        if self.chrome:
            self.chrome.stop()
            self.chrome = None
        self._targets.clear()
        self._pending.clear()
        self._granted.clear()
        self.coords = None

    # ---- 分頁操作 ------------------------------------------------------

    def open(self, url, origin=None):
        """開一個新分頁、套上覆寫、導到 url，回傳 sessionId。

        `origin` 是要預先授權 geolocation 的來源（計畫 §10：真的授權，
        不是像擴充那樣騙 `permissions.query`）。
        """
        self._flush()
        if origin:
            self.grant(origin)
        target = self.cdp.send("Target.createTarget", {"url": "about:blank"})["targetId"]
        session = self.cdp.send(
            "Target.attachToTarget", {"targetId": target, "flatten": True}
        )["sessionId"]
        self._prepare(session, target)
        self.cdp.send("Page.navigate", {"url": url}, session_id=session)
        return session

    def grant(self, origin):
        """授權某個來源使用 geolocation，不跳權限對話框。"""
        if origin in self._granted:
            return
        self.cdp.send("Browser.grantPermissions",
                      {"origin": origin, "permissions": ["geolocation"]})
        self._granted.add(origin)

    def click(self, session, x, y):
        """送真實的滑鼠事件。

        刻意不用 `element.click()` —— 計畫 §8 要求不改動 Google Maps 的 JS 與 DOM，
        從輸入層送事件跟使用者自己按下去是同一條路徑。
        """
        for event_type in ("mousePressed", "mouseReleased"):
            self.cdp.send("Input.dispatchMouseEvent", {
                "type": event_type, "x": x, "y": y,
                "button": "left", "clickCount": 1,
            }, session_id=session)

    def screenshot(self, session, path):
        data = self.cdp.send("Page.captureScreenshot", {"format": "png"},
                             session_id=session)["data"]
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))
        return path

    def evaluate(self, session, expression, await_promise=False):
        self._flush()   # 導頁後新冒出來的 frame / 分頁在這時候補上覆寫
        result = self.cdp.send("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": await_promise,
        }, session_id=session)
        return result.get("result", {}).get("value")

    # ---- 內部 ----------------------------------------------------------

    def _on_attached(self, params, _parent_session):
        """事件處理器只准排隊，**絕對不能在這裡送指令**。

        它是在 `CDP._wait_for()` 的 recv 迴圈裡被呼叫的，在那當下送指令會重入：
        內層的等待會先讀到外層正在等的那則回覆並丟掉，外層就永遠等不到，
        症狀是毫無頭緒的 WebSocketTimeoutException。踩過一次。
        """
        session = params.get("sessionId")
        target = (params.get("targetInfo") or {}).get("targetId")
        if session and target and target not in self._targets:
            self._pending.append((session, target))

    def _flush(self):
        """把排隊中的新分頁補上覆寫。只在 recv 迴圈之外呼叫。"""
        while self._pending:
            self._prepare(*self._pending.pop(0))

    def _prepare(self, session, target):
        if target in self._targets or not self.coords:
            return
        lat, lng, accuracy = self.coords

        # 用 Page.enable 當「這是不是 page target」的判別式：worker 之類的 target
        # 沒有 Page domain，會直接回錯。那種跳過是對的，它本來就沒有定位可覆寫。
        try:
            self.cdp.send("Page.enable", session_id=session)
        except CDPError:
            return

        # 到這裡就確定是 page target 了，**再失敗就是真的失敗**。
        # 早期這裡跟上面共用一個 except，結果是「該補送卻沒補成」被靜默吞掉，
        # 那個分頁會安靜地回報真實位置 —— 跟漏掉補送完全同一個症狀。
        try:
            self.cdp.send("Runtime.enable", session_id=session)
            self.cdp.send("Emulation.setGeolocationOverride", {
                "latitude": lat, "longitude": lng, "accuracy": accuracy,
            }, session_id=session)
        except CDPError as e:
            # 分頁可能在這中間被關掉了，不值得中斷整輪；但一定要吵出來。
            print(f"[gpssim] 警告：session {session} 沒能套上定位覆寫，"
                  f"該分頁會回報真實位置（{e}）", file=sys.stderr)
            return
        self._targets[target] = session
