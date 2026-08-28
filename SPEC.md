# Geo Mock — Chrome 擴充規格

## 目的

開發用的定位覆寫工具。開發者輸入地址或選擇已存地點，讓瀏覽器對任何網站回報指定的
GPS 座標，用來檢視系統在不同區域的呈現結果。

通用工具，不綁特定網站。

## 技術決策（已確定，不需重新討論）

- Manifest V3，純原生 JS，不用 build 工具、不用框架
- 覆寫對象是 `navigator.geolocation`，必須跑在頁面自己的 JS 環境
- 兩個 content script：
  - `inject.js` — `world: MAIN`, `run_at: document_start`，做實際覆寫
  - `bridge.js` — `world: ISOLATED`, `run_at: document_start`，讀 `chrome.storage`
    並透過 CustomEvent 推給 inject.js（MAIN world 拿不到 chrome.storage）
- `world` 寫在 manifest 的 content_scripts 需要 Chrome 111+

## 檔案結構

```
geo-mock/
├─ manifest.json
├─ inject.js
├─ bridge.js
├─ popup.html / popup.js
├─ options.html / options.js
└─ icons/16.png 48.png 128.png
```

## 三種模式

| 模式 | 行為 |
|------|------|
| `off` | 走真實定位，不介入 |
| `fixed` | 回傳設定的固定座標 |
| `jitter` | 以設定座標為中心加隨機偏移，半徑可設 |

jitter 是為了測試座標微幅飄動時 UI 的反應（釘子跳動、重複觸發區域判定）。
注意：是以**設定的座標**為中心抖動，不是以真實位置為中心。

## Popup 面板（主要介面）

由上而下：

1. 標題列：名稱 + 啟用/停用開關
2. 地址搜尋框 → 候選清單（顯示地址與座標）→ 點選即套用
3. 資料來源標示：OpenStreetMap
4. 模式切換：關閉 / 固定 / 抖動（三選一）
5. 目前座標與 accuracy 顯示
6. 已存地點 chips + 新增按鈕
7. 底部：進階設定連結

Options 頁放不常改的欄位：altitude、altitudeAccuracy、heading、speed、jitter 半徑。

## Geocoding

使用 Nominatim：`https://nominatim.openstreetmap.org/search?format=json&q=...`

**使用政策必須遵守**（https://operations.osmfoundation.org/policies/nominatim/）：

- 絕對上限每秒 1 次請求 → 搜尋框要 debounce，至少 1000ms
- 必須快取結果，重複送相同查詢可能被封鎖 → 查過的地址存進 `chrome.storage.local`
- 必須顯示 OpenStreetMap 出處標示
- 需提供可識別應用程式的 HTTP Referer 或 User-Agent

**未解事項**：`fetch` 無法設定 `User-Agent`（瀏覽器禁止的 header），擴充頁的 Referer
是 `chrome-extension://<id>`。這是否符合 Nominatim 的識別要求尚未確認。實作時先驗證，
若被擋則改用有 API key 的服務（LocationIQ / Mapbox / Google Geocoding）。

`manifest.json` 需要 `host_permissions: ["https://nominatim.openstreetmap.org/"]`。

## 實作優先順序

**第一版（先做到能跑）**
1. `getCurrentPosition` 覆寫 + fixed 模式
2. Options 頁存經緯度
3. Popup 開關

**第二版**
4. 地址搜尋 + 候選清單 + 快取
5. 已存地點
6. `chrome.storage.onChanged` 即時推送設定，切換座標免重整頁面
7. jitter 模式

**第三版（撞到再做）**
8. `watchPosition` / `clearWatch`
9. `navigator.permissions.query` 覆寫成 granted
10. `all_frames: true` 支援 iframe
11. per-site 白名單

## 已知的實作陷阱

1. **時序**：`chrome.storage.local.get` 是非同步，頁面可能在設定送達前就呼叫定位 API。
   inject.js 要把請求排隊，等設定到達再回應。這段不能省。

2. **`watchPosition` 必須同步回傳 watch id**，不能等設定載入才回。自己維護計數器當 id，
   再用 `setInterval` 定期送位置。

3. **`navigator.permissions.query({name:'geolocation'})`** — 有些網站先查權限，看到
   prompt 就不呼叫定位了。可能需要一併覆寫。

4. **回傳的是普通物件**，不是真的 `GeolocationPosition`。少數網站會檢查 prototype
   或 `instanceof`。第三版再處理。

## 不要做的事

- 不要引入 build 工具、TypeScript、React
- 不要在第一版就做地圖 picker（Leaflet 要打包進擴充，體積和複雜度大一個量級）
- 不要為了通用性預先實作沒撞到的相容處理
