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
注意：是以**設定的座標**為中心抖動，不是以真實位置為中心。

## Popup 面板（主要介面）

由上而下：

1. 標題列：名稱 + 啟用/停用開關
2. 地址搜尋框 + 搜尋鈕 → 候選清單（顯示地址與座標）→ 點選即套用。
   **按 Enter 或搜尋鈕才查，不做打字即查** —— Nominatim 政策明文禁止 client 端的
   auto-complete，見下方 Geocoding
3. 資料來源標示：OpenStreetMap
4. 模式切換：關閉 / 固定 / 抖動（三選一）
5. 目前座標與 accuracy 顯示
6. 已存地點 chips + 新增按鈕
7. 底部：進階設定連結

Options 頁放不常改的欄位：altitude、altitudeAccuracy、heading、speed、jitter 半徑。

## Geocoding

使用 Nominatim：`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=zh-TW&q=...`

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
8. `watchPosition` / `clearWatch`
9. `navigator.permissions.query` 覆寫成 granted
10. `all_frames: true` 支援 iframe
11. per-site 白名單
