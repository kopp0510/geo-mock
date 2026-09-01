# gpssim/ — Simulator 的核心模組

把「指定座標 → 讓瀏覽器回報它 → 驗證真的生效」拆成互不相依的幾塊。
跑法、踩過的雷、已驗證的事實在上一層的 `../CLAUDE.md`。

## 關鍵檔案

| 檔案 | 職責 | 相依 |
|---|---|---|
| `coords.py` | 座標驗證（±90 / ±180）、「緯度, 經度」拆解、haversine 距離 | 純函式，什麼都不依賴 |
| `geocode.py` | 地址搜尋（Nominatim）+ 速率閘門 + 磁碟快取。`USER_AGENT` 是政策要求的識別，**不可改成標準函式庫的預設值** | 只有標準庫 |
| `detect.py` | OS / 版本 / 架構 / Chrome 執行檔與版本 | 只有標準庫 |
| `cdp.py` | CDP client：send / 事件派送 / pump。**內含 RLock 可跨執行緒共用，每個指令有 30 秒期限** | `websocket-client` |
| `chrome.py` | 起獨立 profile 的 Chrome、等 DevToolsActivePort、收工刪 profile | `detect` |
| `server.py` | 餵 `testpage/` 的本機 http server | 只有標準庫 |
| `route.py` | 路線模型、大圓內插、點到路線的距離 | `coords` |
| `formats.py` | GPX / KML / GeoJSON / 純文字讀檔 | `coords` |
| `player.py` | 按真實時間播放路線，暫停／繼續／停止 | provider |
| `verify.py` | Milestone 1 / 2 與路線的判定，回傳 `Check` | `coords` / `player` |
| `report.py` | 計畫 §22 的回報格式 | 無 |
| `gui.py` | PySide6 介面。**選用相依**，沒裝 PySide6 也不影響其他模組 | 全部 + `cli` 的常數 |
| `cli.py` | 入口，把上面兜起來 | 全部 |
| `providers/` | 「怎麼改掉定位」的抽象與實作（見該層 CLAUDE.md） | `cdp` / `chrome` |

## 此層慣例

- **分層方向是單向的**：`coords` / `detect` 誰都不依賴；`cdp` / `chrome` 只往下；
  `providers` 用它們；`verify` / `report` 只認 provider 的公開方法與 `Check`；
  `cli` 在最上面。**不要讓下層 import 上層**
- **判定一律比距離不比字串**（`coords.haversine`）。浮點尾數差一位不該算失敗
- **`_wait_for` 的期限不能拿掉**。它是「一直讀到自己的 id 為止」，而頁面的事件流
  會讓 `recv()` 一直有東西可讀，**socket 自己的逾時永遠不會觸發** ——
  少了那道期限，一個不回覆的指令會讓整支程式無聲掛死，畫面上只看到轉圈
- **同一個 `CDP` 物件可以跨執行緒用，但別把鎖拿掉**。`send()` 是「寫出去、
  一路讀到自己的 id 為止」，沒有鎖的話兩個執行緒會互相吃掉對方在等的回覆。
  路線播放就是這個情境：player 執行緒每秒送位置，`verify_route` 同時在讀軌跡
- **路線的「算在哪裡」與「什麼時候送」要分開**：`route.py` 是純運算（可直接斷言，
  不必開瀏覽器），`player.py` 才碰時鐘與執行緒。合在一起的話路線邏輯就只能
  靠開瀏覽器驗
- **狀態有五種，不可壓成 PASS/FAIL 兩種**：`PASS` / `FAIL` /
  `PERMISSION_DENIED`（權限問題，不是模擬失敗）/ `UNVERIFIED`（測不到）/ `SKIPPED`。
  把 `UNVERIFIED` report 成 `FAIL` 會讓「Maps 改版」看起來像「模擬壞了」，
  併進 `PASS` 又會讓「沒驗到」看起來像「驗過了」。
  `cli._run` 的 exit code 跟著這條分：0 全過 / 1 失敗 / 2 環境或輸入問題 / 3 有 UNVERIFIED
- **會啟動外部程序的流程，`start()` 一定要在 `try` 裡**，清理放 `finally`。
  `cli._run` 踩過：`provider.start()` 寫在 try 外面，Chrome 起來但 CDP 接不上時
  `stop()` 不會被呼叫，Chrome 跟 temp profile 就留在系統上
- **`detect.py` 的 `chrome_version()` 分平台**：Windows 的 `chrome.exe --version`
  印不出東西，要改讀安裝目錄的版本資料夾或 PowerShell。**問不到版本不等於不能用**
- **`detect.py` 只回報看到什麼，不下支不支援的結論**。能不能用是各 provider
  `is_supported()` 的事 —— 這是為了避免寫出 `if Windows: assume supported`
- **地址查詢只能由使用者的明確動作觸發**（Enter 或按鈕）。綁 `textChanged`
  等於實作 auto-complete，Nominatim 政策明文禁止，會被封鎖
- **`main()` 開頭一定要叫 `enable_utf8_output()`**（`__init__.py`）。它擋兩件事：
  Windows 的預設編碼吃不下中文（`UnicodeEncodeError`），以及 PyInstaller
  `--windowed` 的 exe 根本沒有 stdout（`sys.stdout is None`，`print` 丟
  `AttributeError`）。兩個都是第一個 `print` 就死，實測都踩過
- 註解寫繁體中文，跟隨 repo 既有慣例
- 沒有單元測試框架。驗證靠 `cli.py` 的 `test` / `maps` 實際開瀏覽器跑
- **GUI 的阻塞動作全在 worker thread**，而且 provider 從建立到 `stop()` 必須
  在**同一個 thread**：CDP 的 WebSocket 不是 thread-safe，從 UI thread 呼叫
  `stop()` 會跟正在等回覆的 `recv` 撞在一起。UI thread 只掀一個
  `threading.Event`，收拾仍由 worker 自己做
- **`cli.py` 對 `gui.py` 的 import 一定要延後到函式裡**。寫在檔頭的話，
  沒裝 PySide6 的人連 `detect` 都跑不了

## 與上層的關係

- `cli.py` 的 `SHOTS_DIR` 指向 **repo 根目錄**的 `.screenshots/`（已 gitignore）。
  `REPO_ROOT` 是從 `gpssim/cli.py` 往上兩層 —— `simulator/` 那一層拿掉之後改過的，
  再搬動目錄要記得跟著改
- `providers/` 底下只有 CDP 與 OS 兩種；OS 那個在所有平台都回不支援，
  但要講得出理由（見該層 CLAUDE.md）
