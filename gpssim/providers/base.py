"""Provider 介面。

計畫 §18 的分層：Core Simulator 只認這個介面，換 OS 或換瀏覽器時不必動它。

兩個實作：
- `ChromeCdpProvider`  — browser-level，目前唯一能用的
- `OsNativeProvider`   — OS-level，各平台情況不同，多半不支援
"""

from abc import ABC, abstractmethod


class Support:
    """`is_supported()` 的回覆。不支援時 `reason` 要能直接顯示給使用者看。"""

    def __init__(self, ok, reason=""):
        self.ok = bool(ok)
        self.reason = reason

    def __bool__(self):
        return self.ok

    def __repr__(self):
        return f"Support(ok={self.ok!r}, reason={self.reason!r})"


class LocationProvider(ABC):
    #: 顯示在 §22 報告的「Location Simulation Method」那行
    name = "unknown"
    #: 'os' 或 'browser'，對應計畫 §4 的優先順序
    layer = "browser"

    @abstractmethod
    def is_supported(self) -> Support:
        """這個環境能不能用這個 provider。

        **絕對不要**寫成「看到 Windows 就回 True」（計畫 §17）——
        沒把握就回不支援，不要假裝成功。
        """

    @abstractmethod
    def start(self, lat, lng, accuracy=10):
        """開始模擬。座標必須已經過 coords.validate()。"""

    @abstractmethod
    def stop(self):
        """停止模擬並還原環境（計畫 §13）。重複呼叫要安全。"""
