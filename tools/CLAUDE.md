# tools/ — 驗證工具

放不隨擴充一起發布的開發輔助腳本。**這層的東西不會被打包進擴充**，
manifest.json 沒有引用它們，Chrome 也不會載入。

## 檔案

| 檔案 | 用途 |
|---|---|
| `verify.js` | 開真實瀏覽器載入未封裝擴充，斷言定位覆寫確實生效。6 步開發迴圈步驟 1、5 的驗證入口 |
| `fixtures/test.html` | 測試頁。在 `<head>` 最頂端就呼叫 `getCurrentPosition`，刻意打中「設定未到就先要定位」那條路徑 |

## 跑法

```bash
node tools/verify.js        # exit 0 = 全部通過
```

三項斷言：

1. 定位覆寫生效（載入後呼叫 → 回傳 `bridge.js` DEFAULTS 的座標）
2. 設定未達時的請求排隊（`document_start` 搶先呼叫 → 被壓住十幾 ms 後正確回應）
3. 設定永不到達時仍會回應（腳本會即時造一個「只有 inject.js、沒有 bridge.js」的
   擴充變體來複現這個失敗模式；修正前這裡會永久懸掛）

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

`verify.js` 的 `EXPECT` 是 `../bridge.js` 中 `DEFAULTS` 的手抄副本 —— 無 build 工具
下沒有共用常數的辦法。**改動 `bridge.js` 的 lat/lng 必須同步改這裡**，否則驗證會
比對到過時座標而報 FAIL，失敗訊息會把人誤導到 `inject.js` 去找問題。
