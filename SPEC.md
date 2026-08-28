# Geo Mock — Chrome 擴充規格

> 架構約束、檔案結構、已知實作陷阱、「不要做的事」已移至 [CLAUDE.md](CLAUDE.md)。
> 本檔只放規格本體：功能行為、介面版面、外部服務政策、實作順序。

## 目的

開發用的定位覆寫工具。開發者輸入地址或選擇已存地點，讓瀏覽器對任何網站回報指定的
GPS 座標，用來檢視系統在不同區域的呈現結果。

通用工具，不綁特定網站。

## 三種模式

| 模式 | 行為 |
|------|------|
| `off` | 走真實定位，不介入 |
| `fixed` | 回傳設定的固定座標 |
| `jitter` | 以設定座標為中心加隨機偏移，半徑可設 |

jitter 是為了測試座標微幅飄動時 UI 的反應（釘子跳動、重複觸發區域判定）。
注意：是以**設定的座標**為中心抖動，不是以真實位置為中心。每次呼叫都重新抖，
在半徑內的圓盤上均勻取點。

**實作偏離（已定案）**：`off` 沒有做成第三個模式選項。標題列的啟用開關已經表達
同一件事，做成三選一等於同一個行為開兩個入口，使用者還得猜哪個優先。所以 popup
是「開關 + 固定／抖動兩選一」，`enabled: false` 就是 `off`。這也保住了既有的
`enabled` 儲存狀態與「關掉開關後不再覆寫」那項斷言。

## watchPosition

`getCurrentPosition` 是問一次答一次，`watchPosition` 是訂閱 —— 位置變了就再回呼一次。
導航、外送追蹤、跑步紀錄這類要跟著使用者移動的網站用它。覆寫的行為：

- **watch id 是自己維護的計數器，同步回傳**。呼叫端拿到之後可能立刻 `clearWatch`，
  所以不能像 `getCurrentPosition` 那樣把整個呼叫排隊等設定到達
- **固定模式：送一次就安靜。** 座標不會變，而真正的 `watchPosition` 只在位置**變化**
  時才回呼，每秒重送一組一模一樣的座標是在洗版
- **抖動模式：每秒送一次新座標。** 這正是 jitter 存在的理由（測 UI 在座標飄動時的反應）。
  間隔寫死 1 秒，沒有做成設定項
- 設定變更時，已經在跑的 watch 會跟著改 —— 換座標等於位置變了，那正是它該回報的事
- **開關關掉時，既有的 watch 會交回原生**（走真實定位），不是停止回呼

## Popup 面板（主要介面）

由上而下：

1. 標題列：名稱 + 啟用/停用開關
2. 地址搜尋框 + 搜尋鈕 → 候選清單（顯示地址與座標）→ 點選即套用。
   **按 Enter 或搜尋鈕才查，不做打字即查** —— Nominatim 政策明文禁止 client 端的
   auto-complete，見下方 Geocoding
3. 資料來源標示：OpenStreetMap
4. 模式切換：固定 / 抖動（兩選一；「關閉」由第 1 項的開關表達，見上方實作偏離）。
   抖動模式下第 5 項會多顯示一列半徑
5. 目前座標與 accuracy 顯示
6. 已存地點 chips + 新增按鈕（點 chip 套用、按 × 刪除，上限 12 個；
   名稱用行內輸入框，不用 `prompt()` —— 那在 extension popup 裡會連 popup 一起關掉）
7. 底部：進階設定連結、語言選單

## 語言

介面支援繁體中文與英文，**在擴充內就能切**（popup 底部的選單：繁體中文／English／
跟隨瀏覽器），選擇存在 `storage.local` 的 `locale`。

不用 Chrome 原生的 `_locales` + `chrome.i18n.getMessage`：那套跟隨瀏覽器的 UI 語言，
擴充自己沒辦法在執行時切換。這是開發工具，想看英文介面時不該逼人去改整台瀏覽器的
語言設定。`_locales/` 只留給 manifest 的擴充描述。

- 兩份字串表在 `i18n.js`，key 必須一一對應（漏一個會 fallback 成英文，畫面上看不出
  是漏譯還是刻意不譯）—— `tools/verify.js` 第 1 項靜態擋著
- Nominatim 的 `accept-language` 跟著介面語系走，**快取鍵也要含語系**：
  同一個查詢在中英文底下回的地名不同
- `inject.js` 印在頁面 console 的訊息不翻譯（MAIN world 拿不到字串表）

Options 頁放不常改的欄位：jitter 半徑（已做），以及 altitude、altitudeAccuracy、
heading、speed（未做，第三版）。

## Geocoding

使用 Nominatim：`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=<介面語系>&q=...`

**使用政策必須遵守**（https://operations.osmfoundation.org/policies/nominatim/）。
以下逐條抄自政策原文，不是摘要意譯：

Requirements
- 絕對上限每秒 1 次請求 → `geocode.js` 的 `gate()`
- 需提供可識別應用程式的 HTTP Referer 或 User-Agent，原文補了一句
  「stock User-Agents as set by http libraries will not do」→ 見下方「識別要求」
- 必須快取結果，重複送相同查詢會被歸類為 faulty client 並封鎖
  → 查過的地址存進 `chrome.storage.local`，加上同字串的 in-flight 去重。
  查詢跑在 service worker（`background.js`）而不是 popup：popup 點到外面就銷毀，
  查詢途中被關掉的話結果寫不進快取，重開再查就是第二次相同請求
- 必須顯示 OpenStreetMap 出處標示 → `popup.html` 的 `.attrib`

Unacceptable Use（原文：strictly forbidden and **will get you banned**）
- **Auto-complete search** —— 原文：「you must not implement such a service on the
  client side using the API」。所以搜尋只由 Enter 或搜尋鈕觸發，**不做打字即查**。
  這條跟速率無關，加多長的 debounce 都不合規，別再把 `input` 監聽接回查詢
- Systematic queries / Scraping of details / Reselling —— 本專案不涉及

**識別要求怎麼滿足的（2026-08-28 實測，原「未解事項」的結論）**

先確認了問題比原本預期的更糟：`fetch` 設不了 `User-Agent`（瀏覽器禁止的 header），
而擴充頁的請求實測**連 `Referer` 都沒有**——不是原本以為的 `chrome-extension://<id>`，
Chrome 根本不替擴充頁的 fetch 送這個 header。等於兩條識別路徑都是空的。

解法：`declarativeNetRequest` 的靜態規則（`rules.json`）在請求送出前把 `User-Agent`
改寫成 `geo-mock/<版本>`。DNR 走的是網路層，不受 fetch 的 forbidden header 限制。
實測用 CDP 的 `Network.requestWillBeSentExtraInfo` 看實際上線的 header，確認是改寫
後的值，不是 Chrome 預設 UA。

規則的範圍要看緊。`||nominatim.openstreetmap.org/` 這個 domain anchor **連子網域一起吃、
也不限 scheme**，涵蓋面比字面上寬。更要緊的是被改寫的東西是「身分」本身：使用者自己
在 OSM 站上操作時，那些請求若也被冠上 `geo-mock/…`，OSMF 依 UA 限流或封鎖時擋到的是
我們 —— 為我們沒送過的流量。所以規則加了
`excludedInitiatorDomains: ["openstreetmap.org"]`，兩面都實測過：

- 擴充 popup 送出的請求 → 仍改寫成 `geo-mock/0.1.0`（擴充頁沒有 initiator domain，
  不會被這條排除誤傷）
- 從 `www.openstreetmap.org` 頁面送出的請求 → 保留瀏覽器原本的 UA，沒被冒名

**別把規則範圍放寬到整個 openstreetmap.org。** `tools/verify.js` 第 1 項會靜態擋下
這種放寬，以及規則被刪、被停用、UA 版本號與 manifest 脫鉤。

若日後仍被擋，改用有 API key 的服務（LocationIQ / Mapbox / Google Geocoding）——
`geocode.js` 是唯一送出請求的地方，換服務只動那一支。

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
8. `watchPosition` / `clearWatch` —— **已做**，行為見上方「watchPosition」
9. `navigator.permissions.query` 覆寫成 granted —— **已做**。只攔 geolocation
   這一種，其他權限（notifications、camera…）原樣轉給原生。覆寫沒開、或設定
   始終沒到時也原樣轉回原生 —— 不能自作主張回 granted，那會讓網站以為拿得到
   位置，結果 `getCurrentPosition` 走原生跳出授權對話框
10. `all_frames: true` 支援 iframe —— **已做**，兩個 content script 都要加。
    沒加的症狀是「主頁面正常、嵌在裡面的地圖顯示真實位置」
11. per-site 排除清單 —— **已做**。刻意不叫黑／白名單：這裡不是在擋誰，
    只是「這幾個站別動」。**預設空的**，所以裝上之後的行為跟以前一樣（全部生效）；
    列進清單的網站走真實定位，其餘照常覆寫。比對 `location.host`（**含埠號**，
    開發場景一定會用到 `localhost:3000`），`*.example.com` 只吃子網域。
    規則放在 `sites.js`，content script 與擴充頁共用一份。
    清單本身**不送進 MAIN world** —— 那是一份使用者關心哪些網站的清單，
    頁面讀得到就等於白送一份瀏覽偏好（見 `bridge.js` 的 `NOT_SENT`）
