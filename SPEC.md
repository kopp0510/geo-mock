# Geo Mock — Chrome 擴充規格

> **這份文件只涵蓋 `extension/` 這一層。** Simulator（`simulator/`）的規格見下方
> 「Provider 分層」與 `simulator/CLAUDE.md`。

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
7. 「這個網站不要覆寫」按鈕 —— 把目前這個站加進排除清單，再按一次恢復。
   拿目前分頁的網址需要 `activeTab`；非 http(s) 的分頁（`chrome://`、擴充頁）
   沒有可排除的 host，按鈕整個不出現
8. 底部：進階設定連結、語言選單

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

Options 頁放的東西：

- **貼上座標**欄 —— 接 Google Maps 右鍵複製的「緯度, 經度」整串，自動拆進下面兩欄
  （`type=number` 的欄位吃不下逗號）
- 緯度、經度、accuracy、jitter 半徑 —— 這幾個按「儲存」才寫入
- **排除清單編輯器** —— 與上面幾欄不同，這裡是**即時存**的，因為 popup 那顆
  「這個網站不要覆寫」也是即時的，兩邊行為要一致

altitude、altitudeAccuracy、heading、speed 仍是未做，**未排程**（不在三版清單裡；
目前 `inject.js` 一律回 `null`，還沒撞到需要它們的網站）。

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
10. iframe 支援 —— **已做**。兩個 content script 都要 `all_frames: true`
    **與 `match_about_blank: true`**：前者管有正常 URL 的 frame，後者管沒有 src 的
    （`srcdoc` / `about:blank`，widget 與部分地圖 SDK 就是那樣建的）。
    漏掉任一個的症狀都是「主頁面正常、嵌在裡面的地圖顯示真實位置」
11. per-site 排除清單 —— **已做**。刻意不叫黑／白名單：這裡不是在擋誰，
    只是「這幾個站別動」。**預設空的**，所以裝上之後的行為跟以前一樣（全部生效）；
    列進清單的網站走真實定位，其餘照常覆寫。比對 `location.host`（**含埠號**，
    開發場景一定會用到 `localhost:3000`），`*.example.com` 只吃子網域。
    規則放在 `sites.js`，content script 與擴充頁共用一份。
    清單本身**不送進 MAIN world** —— 那是一份使用者關心哪些網站的清單，
    頁面讀得到就等於白送一份瀏覽偏好（見 `bridge.js` 的 `NOT_SENT`）

---

## Provider 分層（Simulator）

Simulator 把「怎麼改掉定位」抽成 provider，介面在
`simulator/gpssim/providers/base.py`：`is_supported()` / `start()` / `stop()`。
換 OS 或換瀏覽器時只加新的 provider，不動上層。

優先順序與現況：

| 順位 | Provider | 層級 | 現況 |
|---|---|---|---|
| 1 | `OsNativeProvider` | OS | **所有平台皆不支援**。macOS 沒有系統層的定位注入 API；Windows 只有「設定」裡的手動選項；Linux 視 GeoClue／gpsd 而定且 Chrome 多半不走它 |
| 2 | `ChromeCdpProvider` | 瀏覽器 | **預設，唯一實作**。CDP `Emulation.setGeolocationOverride`，即 DevTools「Sensors → Location」背後那支命令 |
| 3 | `ExtensionProvider` | 頁面 JS | 就是 `extension/` 這個擴充。**尚未接上**，目前只能手動安裝使用 |

第 1 順位在每個平台都是完全不同的機制、零共用，而第 2 順位一份程式碼吃三個 OS ——
這是把 CDP 當預設的主要理由。

### 為什麼不用擴充當 Simulator 的預設

擴充覆寫的是 `navigator.geolocation` 的**實例屬性**（`extension/inject.js:198`），
`Geolocation.prototype.getCurrentPosition.call(navigator.geolocation, …)` 走的是原生；
回傳的也不是真的 `GeolocationPosition`。CDP 的覆寫發生在 Blink 內部，
頁面看不出來也繞不過去。

擴充的價值在另一邊：它裝在使用者日常的 Chrome 上，而 CDP 一定要自己起一個獨立
profile 的 Chrome（Chrome 136 起禁止對預設 user-data-dir 開偵錯連線），
那個瀏覽器沒有登入 Google。兩者互補，所以擴充留著，只是排在後面。

### 路線模擬（計畫 §14、§15）

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

### 驗收條件

按下 Start 之後程式印 SUCCESS **不算數**，必須實際讀 `navigator.geolocation`：

1. `navigator.geolocation returns simulated location` —— 自家測試頁，距離 < 10 m
2. `Google Maps receives simulated location` —— Maps 頁面內實測，距離 < 10 m
3. `Google Maps Your Location is near target` —— 按下定位鈕後地圖中心 < 200 m，
   並存截圖供人眼確認藍點

一律比距離不比字串。找不到定位鈕之類的情況回報 `UNVERIFIED` 而非 `FAIL` ——
「測不到」與「模擬失敗」是兩件事。
