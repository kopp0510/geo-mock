# tools/ — 驗證工具

放不隨擴充一起發布的開發輔助腳本。**這層的東西不會被打包進擴充**，
manifest.json 沒有引用它們，Chrome 也不會載入。

## 檔案

| 檔案 | 用途 |
|---|---|
| `verify.js` | 開真實瀏覽器載入未封裝擴充，斷言定位覆寫確實生效。6 步開發迴圈步驟 1、5 的驗證入口 |
| `fixtures/test.html` | 測試頁。在 `<head>` 最頂端就呼叫 `getCurrentPosition`，刻意打中「設定未到就先要定位」那條路徑；同時也有給人看的介面（見下方「手動測試」）|

## 跑法

```bash
node tools/verify.js        # exit 0 = 全部通過
```

六項斷言：

1. 定位覆寫生效（載入後呼叫 → 回傳 `defaults.js` 的座標）
2. 設定未達時的請求排隊（`document_start` 搶先呼叫 → 被壓住十幾 ms 後正確回應）
3. 貼上「緯度, 經度」會拆進兩欄（Google Maps 右鍵複製的格式，位數留滿確認不被截斷）
4. Options 頁存的座標會生效（存一組非預設值 → content script 讀到新值，
   lat/lng/accuracy 都驗；順帶截圖到 `.screenshots/options.png`）
5. 關掉開關後不再覆寫（經 popup 取消勾選 → 重新載入測試頁）。前四項全在測
   「開啟」狀態，`enabled: false` 這條路徑只有這一項驗得到。斷言看的是
   `inject.js` 有沒有印出覆寫痕跡，不是比對座標數值 —— 只比座標的話，
   「停用分支誤送預設值」這種迴歸會綠燈放行
6. 設定永不到達時仍會回應（腳本會即時造一個「只有 inject.js、沒有 bridge.js」的
   擴充變體來複現這個失敗模式；修正前這裡會永久懸掛）

第 3～5 項需要 extension id，靠讀 `chrome://extensions` 的 shadow DOM 取得
（這個擴充沒有 service worker，沒有更現成的路徑）。**這條路徑綁死 Chrome 內部 UI
的自訂元素名稱，Chrome 改版重構就會斷** —— 斷掉時的症狀是第 3 項拋例外，
不會誤判成 PASS。

`makeNoBridgeVariant()` 用**白名單**組變體 manifest，不是「複製全部再刪掉不要的」。
變體目錄只放 `inject.js`，任何指向其他檔案的欄位（`icons`、`options_ui`、
`action.default_popup`）都會讓 Chrome 整個拒絕載入該擴充並彈錯誤視窗。
新增這類 manifest 欄位時**不需要**動這裡，這正是用白名單的原因。

## 手動測試

想自己開瀏覽器確認覆寫有沒有生效，用同一個測試頁：

```bash
python3 -m http.server 8000 -d tools/fixtures
# 然後開 http://localhost:8000/test.html
```

**這頁只呼叫 `navigator.geolocation`，完全不查 IP** —— 所以顯示什麼座標，
就是瀏覽器實際回報給網站的座標，不會有「到底是覆寫生效還是它在猜 IP」的歧義。
公開的定位測試站多半混用 IP fallback，測出來無法歸因，不建議拿來驗這個擴充。

必須用 `http://localhost`，不能用 `file://` —— content script 對 file:// 需要
在 `chrome://extensions` 另外開「允許存取檔案網址」。

## 前提與陷阱

- **必須用 Chrome for Testing，不能用系統的 Chrome stable。** Chrome 151 實測已忽略
  `--load-extension`，連 `--disable-features=DisableLoadExtensionCommandLineSwitch`
  逃生口都失效，擴充清單會是空的、content script 完全不注入，但**不會有任何錯誤訊息**。
  腳本預設去 playwright 的瀏覽器快取找 Chrome for Testing。
- **playwright 刻意不列為專案相依**（SPEC：不引入 build 工具）。腳本自己去找：
  `PLAYWRIGHT_DIR` → 一般 `require` → `~/.npm/_npx` 快取。都找不到會給明確指引。
- `headless: false` 是必要的，MV3 擴充在舊 headless 下不載入。跑起來會閃出瀏覽器視窗。

## 環境變數

| 變數 | 預設 | 用途 |
|---|---|---|
| `CHROME_BIN` | 自動找 | Chrome for Testing 執行檔路徑 |
| `PLAYWRIGHT_DIR` | 自動找 | 含 playwright 的 `node_modules` 目錄 |
| `PORT` | `0`（OS 配埠） | 測試頁的本機埠 |

## 與上層的關係

`verify.js` 的 `EXPECT` 直接 `require('../defaults.js')`，與擴充共用同一份預設值。
**改預設座標只要改 `defaults.js` 那一份**，這裡不必動。

（早期版本這裡是手抄副本，需要兩邊同步；那個陷阱已經拆掉了，別再裝回去。）
