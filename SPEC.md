# GPS / Location Simulator — 規格

## 目標

指定座標（或用地名查出座標），讓瀏覽器的 `navigator.geolocation` 回傳它，
並讓 Google Maps 的「你的位置」出現在該座標附近。

**「把地圖畫面移到某座標」不算數** —— `/maps/@25.03,121.56,15z` 那是換視野，
不是換定位來源。真正要控制的只有 geolocation source。

## 不算數的做法

- 改 Google Maps 的 HTML / JS / DOM，或攔它的 API
- 改 URL 假裝定位變了
- VPN / IP spoofing / 改 DNS / 改 Wi-Fi 資訊

這些可能影響網站的其他地區判斷，但都不是 GPS 模擬。

## 基本要求

| | |
|---|---|
| 座標驗證 | 緯度 −90~90、經度 −180~180，`100, 121.5` 必須被擋下 |
| Secure context | Geolocation 只在 secure context 可用，測試頁走 `http://127.0.0.1`，不用 `file://` |
| 權限 | `permission denied`（code 1）要跟模擬失敗分開回報 |
| Stop / Restore | 停止後必須還原，不能讓環境停在假位置 |
| 驗證 | 按下 Start 就印 SUCCESS 不算數，必須實際讀 `navigator.geolocation` |
| 環境偵測 | 偵測 OS / 版本 / 架構 / 瀏覽器，**不可用 OS 名稱推論支不支援** |

## Provider 分層

Simulator 把「怎麼改掉定位」抽成 provider，介面在
`simulator/gpssim/providers/base.py`：`is_supported()` / `start()` / `stop()`。
換 OS 或換瀏覽器時只加新的 provider，不動上層。

優先順序與現況：

| 順位 | Provider | 層級 | 現況 |
|---|---|---|---|
| 1 | `OsNativeProvider` | OS | **所有平台皆不支援**。macOS 沒有系統層的定位注入 API；Windows 只有「設定」裡的手動選項；Linux 視 GeoClue／gpsd 而定且 Chrome 多半不走它 |
| 2 | `ChromeCdpProvider` | 瀏覽器 | **預設，唯一實作**。CDP `Emulation.setGeolocationOverride`，即 DevTools「Sensors → Location」背後那支命令 |

第 1 順位在每個平台都是完全不同的機制、零共用，而第 2 順位一份程式碼吃三個 OS ——
這是把 CDP 當預設的主要理由。

### 為什麼不在頁面裡改 `navigator.geolocation`

那種做法覆寫的是實例屬性，`Geolocation.prototype.getCurrentPosition.call(...)`
走的仍是原生，而且回傳的不是真的 `GeolocationPosition`。CDP 的覆寫發生在
Blink 內部，頁面看不出來也繞不過去 —— 計畫 §8 要的是後者。

代價是 CDP 一定要自己起一個獨立 profile 的 Chrome（Chrome 136 起禁止對預設
user-data-dir 開偵錯連線），那個瀏覽器沒有登入 Google。

## 路線模擬（計畫 §14、§15）

固定座標驗收全綠之後才做的第二階段。

| 元件 | 職責 |
|---|---|
| `route.py` | 路線模型與內插。**純運算**，不碰瀏覽器也不碰時鐘，可直接斷言 |
| `formats.py` | GPX / KML / GeoJSON / 純文字讀檔。四種格式對同一條路線產生相同結果 |
| `player.py` | 按真實時間播放，暫停／繼續／停止 |

硬性要求：

- **內插走大圓**（`coords.destination`），不是「每秒把緯度加固定值」。
  實測：緯度 25 走正東 1000 m 要 0.009923 度經度，緯度 70 要 0.026294 度 ——
  固定加值會讓實際速度隨緯度飄掉
- **每一拍對出發時間重算該送的時刻**，不是睡固定秒數。後者會把每次送出的耗時
  累積成漂移，跑久了速度就偏慢
- `heading` / `speed` 一起送。CDP 的 `Emulation.setGeolocationOverride`
  收 `latitude` `longitude` `accuracy` `altitude` `altitudeAccuracy` `heading` `speed`
  七個欄位（Chrome 152 的 `/json/protocol` 確認過）

驗收（`Route playback follows the path`）四件事一起看：收到的點貼著路線、
實測速度接近設定值、`heading`/`speed` 有值、暫停期間不再送位置。

**Google Maps 在路線模式下量不出東西**：藍點不會跟著移動，同分頁重按定位鈕也不動，
另開新分頁才更新且拿到的是快取位置。所以 `route --maps` 只印觀察與截圖，不列入判定 ——
做成 UNVERIFIED 的話會永遠 exit 3，久了沒人看 exit code。

## 驗收條件

按下 Start 之後程式印 SUCCESS **不算數**，必須實際讀 `navigator.geolocation`：

1. `navigator.geolocation returns simulated location` —— 自家測試頁，距離 < 10 m
2. `Google Maps receives simulated location` —— Maps 頁面內實測，距離 < 10 m
3. `Google Maps Your Location is near target` —— 按下定位鈕後地圖中心 < 200 m，
   並存截圖供人眼確認藍點

一律比距離不比字串。找不到定位鈕之類的情況回報 `UNVERIFIED` 而非 `FAIL` ——
「測不到」與「模擬失敗」是兩件事。
