# simulator/ — GPS / Location Simulator（Python）

輸入經緯度，讓瀏覽器的 `navigator.geolocation` 回傳指定座標，並實際驗證有沒有生效。

## 技術棧

Python 3.10+，唯一相依 `websocket-client`（CDP 是 JSON-RPC over WebSocket，
標準庫沒有 WebSocket client）。用 `uv` 管理。

> 根目錄 CLAUDE.md 的「無 build 工具、無套件管理器」是講**擴充**那一層的約束，
> 不適用於這裡。兩種產物的技術棧本來就不同。

## 跑法

```bash
cd simulator
uv sync

uv run python -m gpssim.cli detect                              # 環境與 provider 支援情形
uv run python -m gpssim.cli test  --coords "25.033964, 121.564468"   # Milestone 1
uv run python -m gpssim.cli maps  --coords "25.033964, 121.564468"   # Milestone 2
uv run python -m gpssim.cli start --coords "25.033964, 121.564468"   # 開著不關

uv sync --extra gui                          # 裝 PySide6
uv run python -m gpssim.cli gui              # 圖形介面
```

exit code：

| code | 意思 |
|---|---|
| 0 | 全部 PASS |
| 1 | 有 `FAIL` 或 `PERMISSION_DENIED` |
| 2 | 座標無效，或這個環境沒有可用的 provider |
| 3 | 有 `UNVERIFIED` —— **測不到，不是失敗**。要人去看 `.screenshots/` 的截圖才知道 |

3 特別要分出來：Maps 改版讓定位鈕找不到時就是這個，把它併進 0 會讓「沒驗到」
看起來像「驗過了」，併進 1 又會讓「Maps 換版面」看起來像「模擬壞了」。

## 檔案

```
gpssim/
├─ coords.py      # 座標驗證（±90 / ±180）與 haversine。純函式
├─ detect.py      # OS / 版本 / 架構 / Chrome 偵測。只回報看到什麼，不下支不支援的結論
├─ cdp.py         # 極簡 CDP client
├─ chrome.py      # 起獨立 profile 的 Chrome、讀 DevToolsActivePort、收工清乾淨
├─ server.py      # 餵測試頁的本機 http server（secure context 用）
├─ testpage/location-test.html
├─ providers/
│  ├─ base.py         # LocationProvider 介面
│  ├─ chrome_cdp.py   # 唯一實作
│  ├─ os_native.py    # 各平台都不支援，但要講得出理由
│  └─ extension.py    # ../extension/ 那個擴充，尚未接上
├─ verify.py     # Milestone 1 / 2 的判定
├─ report.py     # 回報格式
├─ gui.py        # PySide6 介面。選用相依，`uv sync --extra gui` 才裝得到
└─ cli.py        # 入口（含 `gui` 子指令）
```

## 已驗證的事實（別重查）

- **CDP 覆寫真的有效**：測試頁 0.00 m、Google Maps 頁面內的 `navigator.geolocation`
  0.00 m、Maps 按下定位鈕後地圖中心 0.0 m，藍點截圖人眼確認過
- **Chrome 136 起 `--remote-debugging-port` 對預設 user-data-dir 失效**，必須同時帶
  `--user-data-dir` 指到非預設目錄。所以**不能附接使用者日常的瀏覽器**，
  一定是自己起一個。代價：那個 Chrome 沒登入 Google
- **macOS 沒有 OS 層級的定位注入**。市面上的 LocationSimulator 類工具都是
  「從 Mac 改 iOS 裝置」，不是改 Mac 自己

## 踩過的雷（寫 code 前先看）

1. **`websocket-client` 預設會送 `Origin` header，Chrome 回 403**
   （`Rejected an incoming WebSocket connection from the ... origin`）。
   用 `suppress_origin=True`，**不要**改成加 `--remote-allow-origins=*` ——
   後者等於對所有網頁開放 CDP。

2. **事件處理器裡絕對不能送指令**（`gpssim/providers/chrome_cdp.py` 的 `_on_attached`）。
   它是在 `cdp._wait_for()` 的 recv 迴圈裡被呼叫的，在那當下送指令會重入：
   內層等待會先讀到外層正在等的回覆並丟掉，外層永遠等不到。
   症狀是**遠處某個 send 莫名 WebSocketTimeoutException**，完全看不出跟事件有關。
   處理器只准排隊（`_pending`），由 `_flush()` 在迴圈外補送。
   `cdp._dispatch()` 現在對這種情況直接丟 `CDPError`，不讓它再靜默一次。

3. **`Emulation.setGeolocationOverride` 是 per-session，不是 per-browser**。
   `Target.setAutoAttach` 只讓你「看得到」新 target，**不會**把既有的 override
   帶過去。實測：第二個分頁沒補送就拿到真實位置 24.163, 120.638。
   症狀跟擴充漏 `all_frames` 一模一樣，一樣難歸因。

4. **`DevToolsActivePort` 是 Chrome 起來之後才非同步寫出來的**，必須 poll。
   單次讀會偶發失敗，而且失敗時 Chrome 已經開著了 ——
   症狀是「視窗跳出來但程式說找不到 port」。

5. **測試頁不能用 `file://`**。Geolocation 只在 secure context 下可用，
   `file://` 不算，`http://127.0.0.1` 算（loopback 被規格列為 potentially trustworthy）。

6. **`permission denied` 不是 `simulation failed`**。
   `GeolocationPositionError.code === 1` 要單獨回報成 `PERMISSION_DENIED`，
   跟 code 2/3 分開。目前 CDP 走 `Browser.grantPermissions` 不會跳彈窗，
   但這條分流要留著 —— 哪天換 provider 就會用到。

7. **Google Maps 的定位鈕沒有穩定 selector**，只能靠 `aria-label` 找。
   找不到時回報 **`UNVERIFIED` 不是 `FAIL`** —— 「測不到」跟「模擬失敗」是兩件事。
   另外 Maps 載入時 URL 就已經帶著 `/@lat,lng`（IP 推測的位置），
   所以要等它**變成目標附近**，不能一看到 `/@` 就收工。

## 已知限制（刻意不修）

- **GUI 沒有自動化測試進 repo**。驗證靠一支用完即丟的冒煙腳本：開真視窗、
  按開始、等三項 PASS、按停止、確認沒有殘留 Chrome，逐步截圖到 `.screenshots/`。
  這個專案沒有測試框架，不為了 GUI 引進一個。

- **Python 程序被強制中斷時，那個 Chrome 與 temp profile 會留在系統上**。
  清理靠 `cli._run` 的 `finally` → `provider.stop()`，`kill -9`、agent 被中止、
  終端機直接關掉都不會跑到它。正常結束（含 Ctrl-C）會清乾淨，實測 profile 數
  跑前跑後相同。要修得加 watchdog 或 process group，不值得。
  收拾方式：`pkill -f 'user-data-dir=.*gpssim-'`，temp profile 系統自己會回收。

- **Google Maps 的定位鈕靠 `aria-label` 的關鍵字找，可能選到別的按鈕**。
  選錯的結果是 URL 不會移到目標附近 → 回報 `UNVERIFIED` + 截圖，
  不會誤報成 PASS。這是刻意讓它「寧可測不到，不要測錯」。

## 不要做的事

- 不改 Google Maps 的 HTML / JS / DOM，不攔它的 API，不靠改 URL 假裝定位變了。
  真正要控制的只有 geolocation 來源
- 不把 VPN / IP / DNS / Wi-Fi 那類手段當成 GPS 模擬
- 按下 Start 就印 SUCCESS 不算數，一定要實際讀 `navigator.geolocation`

## 尚未做（依計畫的優先順序，撞到再做）

Route / 速度 / bearing / GPX / KML / GeoJSON / Pause / Resume；
Edge / Firefox / Safari；OS 層 provider。
（PySide6 GUI 已完成 —— 計畫 §19 第三階段）
