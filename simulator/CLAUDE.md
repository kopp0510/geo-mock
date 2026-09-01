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

uv run python -m gpssim.cli search "台北101"                    # 用地標查座標
uv run python -m gpssim.cli detect                              # 環境與 provider 支援情形
uv run python -m gpssim.cli test  --coords "25.033964, 121.564468"   # Milestone 1
uv run python -m gpssim.cli maps  --coords "25.033964, 121.564468"   # Milestone 2
uv run python -m gpssim.cli start --coords "25.033964, 121.564468"   # 開著不關

uv sync --extra gui                          # 裝 PySide6
uv run python -m gpssim.cli gui              # 圖形介面

# 路線（計畫 §14、§15）
uv run python -m gpssim.cli route --file trip.gpx --kmh 50
uv run python -m gpssim.cli route --waypoints "25.03,121.56; 25.04,121.57" --speed 30
```

路線檔支援 `.gpx` `.kml` `.geojson` `.json` `.txt` `.csv`。
`--loop --laps N` 繞圈，`--interval` 改更新間隔，`--maps` 順便開 Google Maps
（只印觀察，不列入判定，理由見下方已知限制）。

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
├─ geocode.py    # 地址搜尋（Nominatim）。政策全兌現在這一支，別在別處另開請求
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
├─ route.py      # 路線模型與大圓內插。純運算，不碰瀏覽器也不碰時間
├─ formats.py    # GPX / KML / GeoJSON / 純文字讀檔
├─ player.py     # 按真實時間播放路線，可暫停／繼續／停止
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

7. **內插一定要用 `coords.destination`（大圓），不可以「每秒把緯度加固定值」**。
   實測：緯度 25 走正東 1000 m 需要 0.009923 度經度，緯度 70 需要 0.026294 度 ——
   固定加值會讓實際速度隨緯度飄掉。計畫 §15 點名的就是這件事。

8. **`Route.nearest_distance` 用點到線段的平面投影，不要改回沿線取樣**。
   取樣版的誤差是「取樣間距的一半」，段長 5 km 取 64 點就有 39 公尺 ——
   路線明明沒偏也會被判成偏掉。

9. **Google Maps 的定位鈕沒有穩定 selector**，只能靠 `aria-label` 找。
   找不到時回報 **`UNVERIFIED` 不是 `FAIL`** —— 「測不到」跟「模擬失敗」是兩件事。
   另外 Maps 載入時 URL 就已經帶著 `/@lat,lng`（IP 推測的位置），
   所以要等它**變成目標附近**，不能一看到 `/@` 就收工。

## 已知限制（刻意不修）

- **Chrome 每換一次 override，都會先對 `watchPosition` 發一個
  `POSITION_UNAVAILABLE` 再發新位置**（同一毫秒）。這是 Chrome 的行為，擋不掉。
  路線播放 40 拍就會夾 40 個假錯誤，驗證那端只計數不判失敗。
  （靜置不動時是 0 錯誤 —— 那是 targetId 去重修好的部分，見 providers/CLAUDE.md）

- **Google Maps 的藍點不會跟著模擬移動**，所以 `route --maps` 只印觀察、不判定。
  實測三層：路線走完 1152 m，測試頁的 `watchPosition` 一路跟到終點（差 0.0 m），
  但 Maps 的藍點停在按下定位鈕當下的位置，前後兩張截圖的藍點在同一個像素上；
  同分頁重按定位鈕照樣不動；另開全新分頁才會更新，而且拿到的是快取的中途位置
  （落在路線 700 m 處，當時 provider 已經在 1152 m 的終點）。
  做成 UNVERIFIED 的話 `route --maps` 會永遠 exit 3，久了沒人看 exit code。
  路線有沒有真的動，看 `Route playback follows the path` 那一項。

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

## Nominatim 使用政策（硬約束，違反會被封鎖）

`geocode.py` 是**唯一**送出地址查詢的地方，政策逐條兌現在那支檔案的開頭註解。
最容易被誤加回來的兩條：

- **不可以打字即查**（auto-complete）。政策原文把它列為 strictly forbidden，
  跟 debounce 拉多長無關。搜尋只由 Enter 或搜尋鈕觸發 ——
  GUI 那邊只綁 `returnPressed` 與按鈕，**別綁 `textChanged`**
- **不要寫自動化測試去打真的查詢**。重複送同一個 query 會被歸類為 faulty client。
  冒煙測試用的是已經在快取裡的字串，不會出網路

每秒至多 1 次、7 天快取、50 筆上限、可識別的 User-Agent、介面上標出處，
都在 `geocode.py` 的常數與 `ATTRIBUTION`。
Python 這邊可以直接設 User-Agent header，不必像擴充那樣繞 declarativeNetRequest。

## 不要做的事

- 不改 Google Maps 的 HTML / JS / DOM，不攔它的 API，不靠改 URL 假裝定位變了。
  真正要控制的只有 geolocation 來源
- 不把 VPN / IP / DNS / Wi-Fi 那類手段當成 GPS 模擬
- 按下 Start 就印 SUCCESS 不算數，一定要實際讀 `navigator.geolocation`

## 尚未做（依計畫的優先順序，撞到再做）

Edge / Firefox / Safari（計畫 §16）；OS 層 provider；`ExtensionProvider` 串接。
（PySide6 GUI 與路線模擬都已完成 —— 計畫 §19 第三階段、§14、§15）
