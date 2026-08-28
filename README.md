# geo-mock

開發用的 Chrome 定位覆寫擴充。設定一組座標，讓瀏覽器對任何網站回報它，
用來檢視系統在不同區域的呈現結果。通用工具，不綁特定網站。

## 安裝

沒有打包上架，開發階段直接載入未封裝項目：

1. 開 `chrome://extensions`
2. 右上角開啟「開發人員模式」
3. 點「載入未封裝項目」，選這個專案資料夾

改完程式碼按該擴充的「重新載入」即生效。需 Chrome 111+（content script 的 `world` 欄位）。

## 使用

- **工具列圖示** → 啟用／停用開關、地址搜尋、目前座標一覽、進階設定連結
- **地址搜尋**（popup）→ 打「台北車站」這類地址或地標，**按 Enter 或旁邊的搜尋鈕**
  出候選清單（地址 + 座標），點一下就套用。查過的字串會快取，重複查不會再送請求。
  刻意不做打字即查——Nominatim 政策明文禁止 client 端的 auto-complete
- **模式**（popup）→ 固定／抖動兩選一。抖動是以設定的座標為中心、在半徑內每次
  重新取一點，用來看 UI 在座標微幅飄動時的反應；半徑在進階設定裡調。
  「關閉」就是把右上角的開關關掉，沒有做成第三個模式
- **已存地點**（popup）→ 按「＋ 存目前座標」給它一個名字，之後點 chip 就套用回來，
  按 × 刪掉。上限 12 個
- **進階設定**（options 頁）→ 設定緯度、經度、accuracy、抖動半徑。
  最上面有「貼上座標」欄，可以把 Google Maps 右鍵複製的
  `24.262246, 120.624503` 這種一整串直接貼進去，會自動拆進下面兩欄

**切換開關或改座標會即時生效，不必重新整理分頁。** 但那只影響頁面**下一次**
呼叫定位 —— 已經把位置抓好存起來的頁面不會自己動，那要 `watchPosition`
（SPEC.md 第三版）。

預設是**開啟**的，座標為台北 101 附近。裝上之後每個網站都會拿到這組座標，
不需要時記得用開關關掉 —— 覆寫生效時 `inject.js` 會在該頁 console 印一行
`[geo-mock] 定位已覆寫為 …`，那是唯一的線索。

## 目前做到哪

第一版（固定座標覆寫）已可用：`getCurrentPosition` 覆寫、options 頁存座標、popup 開關。
第二版做完了：地址搜尋 + 候選清單 + 快取、設定即時推送、已存地點、jitter 抖動模式。

**還沒做**（都是第三版）：`watchPosition` / `clearWatch`、
`navigator.permissions.query` 覆寫、iframe 支援、per-site 白名單。
見 [SPEC.md](SPEC.md) 的實作優先順序。

**已知限制**：頁面自己的 JS 能監聽也能偽造擴充用的 CustomEvent，覆寫也能經
`Geolocation.prototype` 繞過 —— 在會偵測 location spoofing 的網站上，這個擴充
可被看穿也可被停用。細節見 [CLAUDE.md](CLAUDE.md)「已知限制」。

## 開發

```bash
node tools/verify.js        # exit 0 = 十項斷言全過
```

需要 playwright 與 Chrome for Testing（**系統的 Chrome stable 不行**，
151 起已忽略 `--load-extension`）。細節見 [tools/CLAUDE.md](tools/CLAUDE.md)。

## 技術

Manifest V3、純原生 JS，無 build 工具、無相依套件。

地址搜尋使用 [Nominatim](https://nominatim.openstreetmap.org/)，
資料來源 © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors。
它的[使用政策](https://operations.osmfoundation.org/policies/nominatim/)是硬約束：
每秒至多 1 次、必須快取、必須以可識別的 User-Agent 送出、必須標示出處，
而且不得實作打字即查。規定集中在 `geocode.js`、`rules.json`（用 declarativeNetRequest 改寫 User-Agent，
`fetch` 設不了這個 header）與 `background.js`（查詢跑在 service worker，
這樣搜尋途中關掉 popup 也不會浪費掉一次請求）。
`tools/verify.js` 刻意不自動化這段，避免重複請求被封鎖。

## 文件

- [SPEC.md](SPEC.md) — 功能規格：三種模式、Popup 版面、Geocoding 政策、實作順序
- [CLAUDE.md](CLAUDE.md) — 架構約束、已知陷阱、已知限制、開發流程
