# GPS / Location Simulator

輸入座標或地名，讓瀏覽器的 `navigator.geolocation` 回傳指定位置，並**實際驗證**有沒有生效。

用途：檢視自己的網站在不同地區會怎麼呈現。它只影響這支程式自己啟動的那個 Chrome，
不碰你日常的瀏覽器，也不碰作業系統的定位。

## 技術棧

Python 3.10+，唯一相依 `websocket-client`（CDP 是 JSON-RPC over WebSocket，
標準庫沒有 WebSocket client）。GUI 是選用的 PySide6。用 `uv` 管理。

## 跑法

```bash
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
gps-simulator/             ← repo 根目錄就是專案本體
├─ pyproject.toml  uv.lock
├─ README.md  SPEC.md  CLAUDE.md
└─ gpssim/
   ├─ coords.py     # 座標驗證（±90 / ±180）、haversine、方位角、大圓推算。純函式
   ├─ geocode.py    # 地址搜尋（Nominatim）。政策全兌現在這一支，別在別處另開請求
   ├─ detect.py     # OS / 版本 / 架構 / Chrome 偵測。只回報看到什麼，不下支不支援的結論
   ├─ cdp.py        # 極簡 CDP client。內含 RLock 與每指令 30 秒期限
   ├─ chrome.py     # 起獨立 profile 的 Chrome、讀 DevToolsActivePort、收工清乾淨
   ├─ server.py     # 餵測試頁的本機 http server（secure context 用）
   ├─ testpage/     # location-test.html 與 route-test.html
   ├─ route.py      # 路線模型與大圓內插。純運算，不碰瀏覽器也不碰時鐘
   ├─ formats.py    # GPX / KML / GeoJSON / 純文字讀檔
   ├─ player.py     # 按真實時間播放路線，可暫停／繼續／停止
   ├─ providers/
   │  ├─ base.py        # LocationProvider 介面
   │  ├─ chrome_cdp.py  # 唯一實作
   │  └─ os_native.py   # 各平台都不支援，但要講得出理由
   ├─ verify.py     # Milestone 1 / 2 與路線的判定
   ├─ report.py     # 回報格式
   ├─ gui.py        # PySide6 介面。選用相依，`uv sync --extra gui` 才裝得到
   └─ cli.py        # 入口（search / detect / test / maps / route / start / gui）
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

## Windows 上的坑（macOS 開發、CI 實測出來的）

1. **輸出有兩個坑，`enable_utf8_output()` 一次擋掉，別拿掉那行**：
   - **編碼**：Windows 的輸出編碼跟著系統地區設定走（CI 上是 cp1252），
     印中文會丟 `UnicodeEncodeError`。實測：Windows CI 的 `detect` 就是這樣掛的，
     連 Chrome 都還沒開
   - **根本沒有 stdout**：PyInstaller `--windowed` 的 exe 是 GUI 子系統，
     沒有主控台，`sys.stdout` 是 `None`，`print()` 丟
     `AttributeError: 'NoneType' object has no attribute 'write'`。
     實測：打包版 `GPS-Simulator.exe detect` 一行沒印就非零結束。
     導到 devnull 之後**看不到輸出但 exit code 是對的**，CI 就靠這個驗

2. **`chrome.exe --version` 在 Windows 印不出東西**。Chrome 是 GUI 子系統的程式，
   不接父行程的 console，`capture_output` 收到空字串。所以 Windows 走
   `_windows_chrome_version()`：先讀安裝目錄底下那個以版本號命名的資料夾，
   再退回 PowerShell 讀檔案版本資訊。
   **而且「問不到版本」不該擋著不讓跑** —— 版本只是報告上的資訊。
   早期 `is_supported()` 問不到就回 False，Windows 上因此整個拒跑，
   明明 Chrome 好好地裝在那裡。

3. Chrome 路徑清單是對的 —— CI 上在 `C:\Program Files\Google\Chrome\Application\chrome.exe`
   找得到（實測 Chrome 151）。

4. **收拾是乾淨的**（原本擔心 `process.terminate()` 在 Windows 只殺父程序）。
   CI 專門檢查過：跑完 Milestone 1 與 2 之後「沒有殘留的 chrome 程序、
   沒有殘留的 temp profile」。這條疑慮已排除，別再假設它有問題。

Windows CI 的實測結果（`.github/workflows/windows.yml`）：

```
Platform:                    Windows 10.0.26100 (AMD64)
Browser:                     Google Chrome 151.0.7922.174
navigator.geolocation:       PASS  (0.00 m)
Google Maps (geolocation):   PASS  (0.00 m)
Google Maps (Your Location): PASS  (0.00 m)
```

## 版本號

**唯一來源是 git tag。** 發版就兩行：

```bash
git tag v0.3.0
git push origin v0.3.0
```

CI 在打包前跑 `set_version.py`，把版本灌進 `pyproject.toml` 與 `__version__`。
**不要手動改那兩個地方** —— 多一個要記得改的地方就多一個會忘的地方，
這支腳本存在的理由就是修掉那個不一致（tag 已經 v0.2.0，那兩處還停在 0.1.0）。

從原始碼跑會看到 `v0.0.0+dev`，那是刻意的：拿到執行檔的人一眼就知道
是不是 Releases 上的正式版。版本會顯示在 GUI 標題列與 `detect` / `maps` 的報告第一行。

## 打包（單一執行檔）

`.github/workflows/windows.yml` 在 CI 上用 PyInstaller 打包，打 tag（`v*`）就發到 Releases。

```bash
# 本機要試的話
uv run --extra gui --with pyinstaller pyinstaller --onefile --windowed --noconfirm \
  --name "GPS-Simulator" --add-data "gpssim/testpage:gpssim/testpage" launch.py
```

三件事別動壞（第三條是 CI 專屬的）：

- **`--add-data` 一定要帶上 `gpssim/testpage`**。測試頁是執行時讀的檔案，
  漏了 Milestone 1 會失敗。**分隔符號 Windows 用 `;`、macOS/Linux 用 `:`**
- **`launch.py` 帶參數走 CLI、不帶開 GUI**。這是為了讓打包出來的東西自我驗證
  （`GPS-Simulator maps --coords ...`），不然打包壞掉只有人雙擊才會發現。
  CI 兩個平台都跑這一步
- **macOS 要分 arm64 與 Intel 兩份**，PySide6 的 wheel 是分架構的。
  `.app` 是資料夾，要 `ditto -c -k --keepParent` 壓起來才保得住執行權限

- **CI 裡驗打包版不要用 `--coords`，用 `--lat` / `--lng`**。
  `"25.033964, 121.564468"` 裡有空格，`Start-Process` 會把它拆成兩個參數，
  程式收到殘缺座標回 exit 2 —— 看起來像打包壞了，其實是參數傳錯
- **Intel Mac 的 runner 標籤是 `macos-15-intel`，不是 `macos-13`**（後者 2025 年
  12 月已退役）。寫錯的話 job 會卡在「Waiting for a runner」直到逾時，
  不會有任何錯誤訊息。那也是最後一個 x86_64 映像，2027 年 8 月之後就沒有了
- **在 Windows 上拿打包版的 exit code 要用 `Start-Process -Wait -PassThru`**。
  PowerShell 的 `&` 對 GUI 子系統的 exe **不會等它結束**就返回，
  `$LASTEXITCODE` 是空字串 —— 症狀是 CI 印出「失敗（exit ）」，
  看起來像程式壞了，其實程式根本還沒跑完

實測大小：Windows 47 MB、macOS arm64 37 MB。兩邊都沒有簽章，
第一次開會被 SmartScreen / Gatekeeper 擋，做法寫在 `.github/release-notes.md`。

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
  收拾方式：**`pkill -9 -f 'user-data-dir=.*gpssim-'`，`-9` 不能省** ——
  預設的 SIGTERM 對卡住的 Chrome 沒用，實測有個 orphan（ppid 1）撐了 14 分鐘、
  連續三次 `pkill` 都沒死，換 SIGKILL 才收掉。temp profile 系統自己會回收。
  判斷是不是這種殘留：看 `ps -o ppid=`，是 1 就代表它的 Python 父程序已經死了。

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

---

## 開發流程（每個功能段落依序走）
<!-- dd-loop-version: 8step；供 /dd-init 判斷是否提議升級，勿刪 -->

1. **實作功能 + 首輪測試通過**（本專案無單元測試框架 → 退化為
   「跑得起來且手動走過該功能」，用 `uv run python -m gpssim.cli`。
   不可帶紅燈進 commit）
2. **commit**（第一次 — 保留簡化前還原點）
3. 跑 **code-simplifier**（對該段新增/修改的程式碼，官方 agent）
4. 跑 **code-review**（該段 diff，每段全量跑；修掉 Critical/Important 才續行）
5. **再測一次** — 確認步驟 3、4 沒破壞行為。**動到哪一層就跑哪一層，兩層都動就兩個都跑**：
   ```bash
   uv run python -m gpssim.cli detect
   uv run python -m gpssim.cli maps --coords "25.033964, 121.564468"   # exit 0 才算過
   ```
   `maps` 會實際開 Chrome、開 Google Maps、按定位鈕、存截圖到 `.screenshots/`。
   **exit 0（三項全 PASS）才算過**。exit 3 是有項目 `UNVERIFIED` ——
   測不到不等於失敗，要去看截圖確認藍點再判斷。
   - 改到路線：`uv run python -m gpssim.cli route --file <路線檔> --kmh 50`
   - 改到 GUI：開真視窗走一遍（開始 → 驗證 → 停止），截圖存 `.screenshots/`
   - 改到地址搜尋：**不要跑自動化迴圈**（Nominatim 政策），手動查一兩次就好

6. **再 commit**（最終版本）
7. **沉澱本輪所學**（有才做）— 本輪若留下踩雷、指令或慣例，用
   claude-md-management plugin 的 /revise-claude-md 寫進 CLAUDE.md；
   它會先列出建議、等你同意才寫檔。沒有值得留的就跳過，不硬湊
8. **評分 & 修正本輪動過的 CLAUDE.md** — 第一個動作是算範圍，不是開始審：

   ```bash
   { git show --name-only --pretty=format: HEAD; git status --porcelain | awk '{print $NF}'; } \
     | grep 'CLAUDE\.md$' | sort -u
   ```

   算出幾份就只審那幾份（用 claude-md-improver）。該 skill 的 Phase 1 寫的是
   「find 全部」，不先算範圍就會把本輪沒動到的那份也審進去（只改了根目錄那份，
   卻連 tools/CLAUDE.md 一起掃）。範圍是空的才跳過

驗證不過 → 修完重跑步驟 5，不可帶著紅燈進步驟 6。

## CLAUDE.md 維護

- 每個有程式碼的資料夾都要有 CLAUDE.md（說明該層職責與慣例）
- 功能落地後，受影響目錄的 CLAUDE.md 逐層堆疊更新
  （用 claude-md-management plugin 的 /revise-claude-md 或手動）
- SPEC.md 的決策若在實作中被推翻，同批更新 SPEC.md，不要讓規格與實作分岔
- 步驟 7 處理的是「本輪學到什麼」，與上一條的「程式碼改了所以文件要同步」是兩件事
- **步驟 7 跳過不代表步驟 8 跳過**：步驟 2、6 被 pre-commit gate 逼著更新的 CLAUDE.md
  也要進步驟 8 的範圍 — gate 只確認「有寫」、不確認「寫得對」
