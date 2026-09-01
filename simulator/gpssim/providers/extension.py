"""Browser-level provider 的另一條路：同 repo 的 geo-mock 擴充（`../extension/`）。

**尚未實作**，介面先留著。它補的是 CDP 唯一的缺點：CDP 一定要自己起一個獨立
profile 的 Chrome（Chrome 136 起的安全限制），那個瀏覽器沒有登入 Google；
擴充則是裝在使用者日常的 Chrome 上，所有分頁都生效。

代價是它在頁面的 JS 環境裡改 `navigator.geolocation` 的**實例屬性**，
`Geolocation.prototype.getCurrentPosition.call(navigator.geolocation, …)` 繞得過去
（`extension/inject.js:31-33` 自己記著這件事），而且回傳的不是真的
`GeolocationPosition`。所以它做不到計畫 §8 要求的乾淨度，才排在 CDP 後面。
"""

from .base import LocationProvider, Support


class ExtensionProvider(LocationProvider):
    name = "geo-mock Chrome extension"
    layer = "browser"

    def is_supported(self):
        return Support(False, "尚未實作：擴充目前只能手動安裝與操作，Simulator 還沒接上它")

    def start(self, lat, lng, accuracy=10):
        raise NotImplementedError(self.is_supported().reason)

    def stop(self):
        pass
