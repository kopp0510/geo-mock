"""OS-level provider（計畫 §4 第一優先）—— 目前沒有任何平台實作得出來。

留這個檔案不是佔位，是為了讓「不支援」有個能講出理由的地方。
計畫 §4 第三優先寫得很明白：**不要假裝成功**。

各平台現況：

- **macOS**：沒有系統層的定位注入。市面上叫 LocationSimulator 的工具全都是
  「從 Mac 去改 iOS 裝置的位置」，不是改 Mac 自己；Xcode 的 Simulate Location
  也只餵給它自己啟動的 run target。
- **Windows**：WinRT 有 Geolocator，但模擬位置是「設定 → 隱私權」裡的手動選項，
  沒有給程式呼叫的公開注入 API。未驗證，先當不支援。
- **Linux**：GeoClue / gpsd 可以餵假的 NMEA，但要看發行版怎麼裝、Chrome 是否
  走 GeoClue（多半走 Google 的網路定位服務）。未驗證，先當不支援。

三個平台各自是完全不同的機制，零共用——這也是選 browser-level 的理由之一：
一份 CDP 程式碼吃三個 OS。
"""

import platform

from .base import LocationProvider, Support

_REASONS = {
    "Darwin": "macOS 沒有系統層的定位注入 API（Xcode 的 Simulate Location 只作用於它自己的 run target）",
    "Windows": "Windows 的模擬位置只有「設定 → 隱私權」的手動選項，沒有公開的注入 API（未實測）",
    "Linux": "Linux 需視 GeoClue / gpsd 設定而定，且 Chrome 多半不走它（未實測）",
}


class OsNativeProvider(LocationProvider):
    name = "OS-level location injection"
    layer = "os"

    def is_supported(self):
        system = platform.system()
        return Support(False, _REASONS.get(system, f"{system} 上沒有已驗證的 OS 層機制"))

    def start(self, lat, lng, accuracy=10):
        raise NotImplementedError(self.is_supported().reason)

    def stop(self):
        pass
