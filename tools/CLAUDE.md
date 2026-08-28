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

十一項斷言（第 1 項純靜態，其餘要開瀏覽器）：

1. **兩條政策設定沒有壞掉**（`checkPolicySetup()`，只讀檔不送請求）。
   共同點是壞掉都**靜默** —— 搜尋照樣有結果，要到被 Nominatim 封鎖那天才發現：
   - **改寫 User-Agent 的 DNR 規則**：規則檔被刪、`enabled` 被改 false、權限被拿掉、
     `urlFilter` 被放寬到整個 openstreetmap.org、或 UA 的版本號跟 manifest 脫鉤。
     **版本號那項是刻意的同步閘門**：`rules.json` 的 UA 是手抄的版本號
     （靜態規則讀不到 manifest），只改 manifest 升版這裡就會紅
   - **查詢跑在 service worker**：manifest 有沒有註冊 `background.service_worker`、
     `popup.html` 有沒有又直接載入 `geocode.js`。查詢搬回 popup 的話，
     「中途關掉 popup → 結果沒進快取 → 下次重送同一個 query」那個洞就回來了
   - **`geocode.js` 的 `TIMEOUT_MS` 短於 30 秒**：Chrome 會終止「fetch 超過 30 秒
     還沒回應」的 service worker，而 `gate()` 的時間戳在 fetch 之前就落地了 ——
     把逾時調長到 30 秒以上，就等於把上面那個洞從另一個方向開回來
2. 定位覆寫生效（載入後呼叫 → 回傳 `defaults.js` 的座標）
3. 設定未達時的請求排隊（`document_start` 搶先呼叫 → 被壓住十幾 ms 後正確回應）
4. 貼上「緯度, 經度」會拆進兩欄（Google Maps 右鍵複製的格式，位數留滿確認不被截斷）
5. Options 頁存的座標會生效（存一組非預設值 → content script 讀到新值，
   lat/lng/accuracy 都驗；順帶截圖到 `.screenshots/options.png`）
6. **改設定不重整分頁也生效**（options 存第二組座標 → **不** `page.goto` →
   輪詢到測試頁吃到新值）。這一項唯一在測的就是「沒有重整」這件事，所以那行
   `page.goto` 千萬別為了穩定性補回去，補了就變成第 5 項的重複 —— 斷言裡種了
   一個 per-document 哨兵盯著這件事，補了 `page.goto` 會立刻紅，不會默默失去意義。
   **注意這一項只驗座標路徑**：「切換開關也即時生效」目前只有手動驗證涵蓋
   （第 10 項雖然測開關，但它刻意重新載入頁面，靠 `announced` 重置取得乾淨訊號）
7. **jitter 模式在設定座標周圍抖動**（options 存半徑 → popup 切到抖動 →
   **同樣不重整**測試頁 → 連取 8 個樣本）。三件事一起驗：真的抖了、沒抖出半徑、
   每次都不一樣 —— 少了最後一項，「只在切換模式時抖一次然後固定住」也會綠燈。
   驗完會把 mode 改回 fixed，後面才是在測開關而不是順便測到模式。
   **注意這條斷言是實作的鏡子**：`metersFrom()` 用的投影常數與 `jitterCoords()`
   同一組，所以它保證不了「經度換算正確」—— 若哪天 `/ shrink` 那個除法掉了，
   驗證換算回公尺時會再乘一次 `cos`，量到的距離只會變小，照樣綠燈
8. **推送的內容不含已存地點**（在測試頁監聽 `geo-mock:settings`，斷言 detail 裡
   沒有 `places`、也沒有地點名稱字串；同時斷言存地點這個寫入觸發 0 次推送）。
   這個事件頁面自己的 JS 監聽得到，少了 `bridge.js` 的 `pick()` 過濾，使用者
   自己命名的地點簿連同精確座標會被每個網站讀走 —— **而且功能完全正常、
   沒有任何症狀**，只有這一項擋得住那種回退
9. **`watchPosition` / `clearWatch`**：id 同步回傳（是 `number`，不是 undefined）、
   固定模式只送一次、切到 jitter 後持續送且座標互不相同、`clearWatch` 之後完全安靜。
   這一項約 7 秒，是全部斷言裡最慢的，因為要真的等計時器跑
10. 關掉開關後不再覆寫（經 popup 取消勾選 → 重新載入測試頁）。第 2～9 項全在測
   「開啟」狀態，`enabled: false` 這條路徑只有這一項驗得到。斷言看的是
   `inject.js` 有沒有印出覆寫痕跡，不是比對座標數值 —— 只比座標的話，
   「停用分支誤送預設值」這種迴歸會綠燈放行
11. 設定永不到達時仍會回應（腳本會即時造一個「只有 inject.js、沒有 bridge.js」的
   擴充變體來複現這個失敗模式；修正前這裡會永久懸掛）

**為什麼不驗地址搜尋**：Nominatim 政策明文禁止自動化的重複查詢，跑一次 CI 就打一次
別人捐的伺服器。搜尋功能只做手動驗證（見下方「手動測試」）；能靜態比對的部分
（第 1 項）才進斷言。

第 4～10 項需要 extension id，靠讀 `chrome://extensions` 的 shadow DOM 取得
（早期這個擴充沒有 service worker，shadow DOM 是唯一路徑。現在有 `background.js` 了，
理論上可以改用 playwright 的 `context.serviceWorkers()` 拿 id —— 但目前這條還能用，
沒有動它的理由；哪天 Chrome 改版把它弄斷，那是第一個該試的替代方案）。**這條路徑綁死 Chrome 內部 UI
的自訂元素名稱，Chrome 改版重構就會斷** —— 斷掉時的症狀是第 4 項拋例外，
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

`rules.json` 的 User-Agent 就沒這麼好運 —— 靜態 DNR 規則讀不到 manifest，版本號只能
手抄。拆不掉的副本就用斷言看著：第 1 項會比對 UA 是否含 `manifest.json` 的 `version`，
升版忘了同步就會紅。
