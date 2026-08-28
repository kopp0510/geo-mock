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
