"""按真實時間把一條路線播放給瀏覽器（計畫 §14、§15 的 Pause / Resume）。

`route.py` 只算「走了 N 公尺在哪裡」，什麼時候送出去是這裡的事。
分開的好處是路線本身可以直接斷言，不必開瀏覽器。
"""

import threading
import time


class RoutePlayer:
    """在自己的 thread 上播放路線，可暫停、繼續、停止。

    `on_fix(fix)` 每送出一筆位置就呼叫一次（給 UI 更新進度用）。
    它跑在 player 的 thread 上，**碰 UI 的話要自己丟回主執行緒**。
    """

    def __init__(self, provider, route, on_fix=None, laps=1):
        self.provider = provider
        self.route = route
        self.on_fix = on_fix
        self.laps = laps

        self._stop = threading.Event()
        self._resume = threading.Event()
        self._resume.set()          # 沒被暫停時是「通行」狀態
        self._thread = None
        self.state = "idle"         # idle / running / paused / finished / stopped
        self.sent = 0

    # ---- 控制 ----------------------------------------------------------

    def start(self):
        self.state = "running"
        self._thread = threading.Thread(target=self._run, daemon=True, name="gpssim-route")
        self._thread.start()
        return self

    def pause(self):
        if self.state == "running":
            self._resume.clear()
            self.state = "paused"

    def resume(self):
        if self.state == "paused":
            self._resume.set()
            self.state = "running"

    def stop(self):
        self._stop.set()
        self._resume.set()          # 暫停中被叫停也要醒得過來
        if self._thread:
            self._thread.join(timeout=10)
        if self.state not in ("finished",):
            self.state = "stopped"

    def join(self, timeout=None):
        if self._thread:
            self._thread.join(timeout)
        return self.state

    # ---- 內部 ----------------------------------------------------------

    def _run(self):
        started = time.monotonic()
        paused_total = 0.0

        for fix in self.route.fixes(self.laps):
            # 每一拍都對「出發時間」重算該送的時刻，不是「睡 interval 秒」——
            # 後者會把每次送出的耗時累積成漂移，跑久了實際速度就偏慢。
            while True:
                if self._stop.is_set():
                    self.state = "stopped"
                    return
                if not self._resume.is_set():
                    paused_at = time.monotonic()
                    self._resume.wait()
                    paused_total += time.monotonic() - paused_at
                    continue
                now = time.monotonic()
                due = started + paused_total + fix.elapsed
                if now >= due:
                    break
                # 切小段睡，暫停與停止才不用等一整個 interval 才有反應
                time.sleep(min(0.05, due - now))

            self.provider.set_position(fix.lat, fix.lng, heading=fix.heading, speed=fix.speed)
            self.sent += 1
            if self.on_fix:
                self.on_fix(fix)

        self.state = "finished"
