# geo-mock

開發用的 Chrome 定位覆寫擴充。輸入地址或選已存地點，讓瀏覽器對任何網站回報指定的
GPS 座標，用來檢視系統在不同區域的呈現結果。通用工具，不綁特定網站。

**完整規格見 [SPEC.md](SPEC.md)** — 三種模式行為、Popup 面板版面、Nominatim 使用政策、
三版實作優先順序。本檔只放每輪都該遵守的約束與慣例。

## 技術棧

Manifest V3、純原生 JS。無 build 工具、無套件管理器、無測試框架。

## 目錄結構

```
geo-mock/
├─ README.md          # 對外簡介（第一版能跑後補安裝/使用說明）
├─ SPEC.md            # 功能規格
├─ CLAUDE.md          # 本檔：架構約束與開發流程
├─ manifest.json
├─ inject.js          # world: MAIN, run_at: document_start — 實際覆寫 geolocation
├─ bridge.js          # world: ISOLATED, run_at: document_start — 讀 storage 推給 inject
├─ popup.html / popup.js
├─ options.html / options.js
└─ icons/16.png 48.png 128.png
```

## 架構約束（已定案，不重新討論）

- 覆寫對象是 `navigator.geolocation`，必須跑在頁面自己的 JS 環境
- **雙 content script 不可合併**：MAIN world 拿不到 `chrome.storage`，所以由
  ISOLATED world 的 `bridge.js` 讀設定、用 CustomEvent 推給 MAIN world 的 `inject.js`
- manifest 的 `content_scripts` 用 `world` 欄位需要 Chrome 111+
- `manifest.json` 需 `host_permissions: ["https://nominatim.openstreetmap.org/"]`

## 不要做的事

- 不引入 build 工具、TypeScript、React
- 第一版不做地圖 picker（Leaflet 要打包進擴充，體積和複雜度大一個量級）
- 不為了通用性預先實作沒撞到的相容處理
- 不擅自跳過 SPEC.md 的三版優先順序去做第三版項目

## 已知陷阱（寫 code 前先看）

1. **時序**：`chrome.storage.local.get` 是非同步，頁面可能在設定送達前就呼叫定位 API。
   `inject.js` 要把請求排隊，等設定到達再回應。**這段不能省。**

2. **`watchPosition` 必須同步回傳 watch id**，不能等設定載入才回。自己維護計數器當 id，
   再用 `setInterval` 定期送位置。

3. **`navigator.permissions.query({name:'geolocation'})`** — 有些網站先查權限，看到
   prompt 就不呼叫定位了。可能需一併覆寫成 granted。

4. **回傳的是普通物件**，不是真的 `GeolocationPosition`。少數網站會檢查 prototype 或
   `instanceof`。第三版再處理。

5. **jitter 以「設定的座標」為中心抖動**，不是以真實位置為中心。

6. **Nominatim 使用政策是硬約束**（見 SPEC.md）：搜尋框 debounce ≥1000ms、結果必須快取
   進 `chrome.storage.local`、必須顯示 OpenStreetMap 出處。違反會被封鎖。

## 開發流程（每個功能段落依序走）
<!-- dd-loop-version: 6step；供 /dd-init 判斷是否提議升級，勿刪 -->

1. **實作功能 + 首輪測試通過**（本專案無測試框架 → 退化為「擴充能載入且手動走過該功能」，
   不可帶紅燈進 commit）
2. **commit**（第一次 — 保留簡化前還原點）
3. 跑 **code-simplifier**（對該段新增/修改的程式碼，官方 agent）
4. 跑 **code-review**（該段 diff，每段全量跑；修掉 Critical/Important 才續行）
5. **再測一次** — 確認步驟 3、4 沒破壞行為：
   - 重新載入擴充：`chrome://extensions` → 開發者模式 → 「重新載入」該擴充；
     檢查 service worker 與 content script 的 console 無錯誤
   - **playwright 開真實瀏覽器驗證**：以 persistent context 載入 unpacked 擴充
     （`--disable-extensions-except=<專案路徑> --load-extension=<專案路徑>`，
     需 headed 或 new headless 模式；MV3 擴充在舊 headless 下不載入 —
     實作時先驗證此前提），開任一測試頁呼叫
     `navigator.geolocation.getCurrentPosition()`，斷言回傳座標等於設定值
   - 改到 popup / options UI 時截圖，一律存 `.screenshots/`（已 gitignore），
     勿丟專案根目錄
   - 改到 geocoding 時：`curl -A 'geo-mock/1.0' 'https://nominatim.openstreetmap.org/search?format=json&q=<地址>'`
     驗證 API 實際回應（注意 SPEC.md「未解事項」：fetch 無法設 User-Agent，
     擴充端能否通過 Nominatim 識別要求尚未確認）
6. **再 commit**（最終版本）

驗證不過 → 修完重跑步驟 5，不可帶著紅燈進步驟 6。

## CLAUDE.md 維護

- 每個有程式碼的資料夾都要有 CLAUDE.md（說明該層職責與慣例）
- 功能落地後，受影響目錄的 CLAUDE.md 逐層堆疊更新
  （用 claude-md-management plugin 的 /revise-claude-md 或手動）
- SPEC.md 的決策若在實作中被推翻（例如 Nominatim 擋擴充、改用 LocationIQ），
  同批更新 SPEC.md，不要讓規格與實作分岔
