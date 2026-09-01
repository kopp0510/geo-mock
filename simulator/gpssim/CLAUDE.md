# gpssim/ — Simulator 的核心模組

把「指定座標 → 讓瀏覽器回報它 → 驗證真的生效」拆成互不相依的幾塊。
跑法、踩過的雷、已驗證的事實在上一層的 `../CLAUDE.md`。

## 關鍵檔案

| 檔案 | 職責 | 相依 |
|---|---|---|
| `coords.py` | 座標驗證（±90 / ±180）、「緯度, 經度」拆解、haversine 距離 | 純函式，什麼都不依賴 |
| `detect.py` | OS / 版本 / 架構 / Chrome 執行檔與版本 | 只有標準庫 |
| `cdp.py` | CDP client：send / 事件派送 / pump | `websocket-client` |
| `chrome.py` | 起獨立 profile 的 Chrome、等 DevToolsActivePort、收工刪 profile | `detect` |
| `server.py` | 餵 `testpage/` 的本機 http server | 只有標準庫 |
| `verify.py` | Milestone 1 / 2 的判定，回傳 `Check` | `coords` |
| `report.py` | 計畫 §22 的回報格式 | 無 |
| `cli.py` | 入口，把上面兜起來 | 全部 |
| `providers/` | 「怎麼改掉定位」的抽象與實作（見該層 CLAUDE.md） | `cdp` / `chrome` |

## 此層慣例

- **分層方向是單向的**：`coords` / `detect` 誰都不依賴；`cdp` / `chrome` 只往下；
  `providers` 用它們；`verify` / `report` 只認 provider 的公開方法與 `Check`；
  `cli` 在最上面。**不要讓下層 import 上層**
- **判定一律比距離不比字串**（`coords.haversine`）。浮點尾數差一位不該算失敗
- **狀態有五種，不可壓成 PASS/FAIL 兩種**：`PASS` / `FAIL` /
  `PERMISSION_DENIED`（權限問題，不是模擬失敗）/ `UNVERIFIED`（測不到）/ `SKIPPED`。
  把 `UNVERIFIED` report 成 `FAIL` 會讓「Maps 改版」看起來像「模擬壞了」，
  併進 `PASS` 又會讓「沒驗到」看起來像「驗過了」。
  `cli._run` 的 exit code 跟著這條分：0 全過 / 1 失敗 / 2 環境或輸入問題 / 3 有 UNVERIFIED
- **會啟動外部程序的流程，`start()` 一定要在 `try` 裡**，清理放 `finally`。
  `cli._run` 踩過：`provider.start()` 寫在 try 外面，Chrome 起來但 CDP 接不上時
  `stop()` 不會被呼叫，Chrome 跟 temp profile 就留在系統上
- **`detect.py` 只回報看到什麼，不下支不支援的結論**。能不能用是各 provider
  `is_supported()` 的事 —— 這是為了避免寫出 `if Windows: assume supported`
- 註解寫繁體中文，跟隨 repo 既有慣例
- 沒有單元測試框架。驗證靠 `cli.py` 的 `test` / `maps` 實際開瀏覽器跑

## 與上層的關係

- `cli.py` 的 `SHOTS_DIR` 指向 **repo 根目錄**的 `.screenshots/`（已 gitignore），
  不是 `simulator/` 底下。跟 `tools/verify.js` 的截圖放同一處
- `providers/extension.py` 指的是 `../../extension/` 那個 Chrome 擴充，
  目前只是介面殼，沒有實際串接
