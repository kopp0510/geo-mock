# GPS / Location Simulator

指定一個位置，**讓網站問你在哪裡的時候，瀏覽器回報你指定的座標**，而不是你真正的位置。

用來做什麼：

- 你的網站會依使用者所在縣市顯示不同內容，想在自己電腦上看看台南的使用者會看到什麼
- 外送、地圖、找門市這類功能，想測「使用者在很遠的地方」時畫面長怎樣
- 想確認網站在拿不到位置時會不會出錯

它**只影響這支程式自己開的那個 Chrome**，不碰你日常在用的瀏覽器，也不碰作業系統的定位。

> 這是開發／測試工具，不會讓你「真的」出現在別的地方。

---

## 快速上手

需要 [uv](https://docs.astral.sh/uv/) 與 Google Chrome。

```bash
git clone https://github.com/kopp0510/gps-simulator.git
cd gps-simulator
uv sync --extra gui                      # 不需要圖形介面的話，uv sync 就好
uv run python -m gpssim.cli gui
```

圖形介面的流程：

1. 最上面打地名（例如「台北101」）按 **Enter**，點一下結果就填進座標欄 ——
   也可以直接把「25.033964, 121.564468」整串貼進緯度欄，會自動拆成兩欄
2. 按「**開始模擬**」→ 它會開一個 Chrome、跑完驗證、把結果印在下面
3. 那個瀏覽器會**保持開著**讓你自己操作，裡面的定位就是你設的座標
4. 按「**停止模擬**」或關掉視窗，就會收掉瀏覽器並還原

只想用命令列的話：

```bash
# 看看這台電腦支援哪些做法
uv run python -m gpssim.cli detect

# 開始模擬並實際驗證（會開一個 Chrome 視窗）
uv run python -m gpssim.cli maps --coords "25.033964, 121.564468"
```

跑完會印出這樣的結果，**三項都 PASS 才算真的成功**：

```
Platform:                    Darwin 14.6.1 (arm64)
Browser:                     Google Chrome 152.0.7977.65
Location Simulation Method:  CDP Emulation.setGeolocationOverride
Supported:                   YES

navigator.geolocation:       PASS  (0.00 m)
Google Maps (geolocation):   PASS  (0.00 m)
Google Maps (Your Location): PASS  (0.00 m)
```

它還會把 Google Maps 的截圖存到 `.screenshots/`，可以直接看藍點在不在正確位置。

### 用地名找座標

不必記經緯度，直接查：

```bash
uv run python -m gpssim.cli search "台北101"
# 1. 25.033835, 121.564499  台北101, 7, 信義路五段, 信義區, 臺北市, 臺灣
```

圖形介面最上面也有搜尋框，打地名按 Enter，點一下結果就填進座標欄。

> 地址資料來自 [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors（Nominatim）。
> 它的使用政策是硬約束：每秒至多一次、必須快取、**不做打字即查** ——
> 所以要按 Enter 或搜尋鈕才會查。

### 模擬移動（路線）

不只定在一個點，也可以沿著一條路線移動：

```bash
# 從 GPX / KML / GeoJSON / 純文字檔讀路線
uv run python -m gpssim.cli route --file trip.gpx --kmh 50

# 或直接寫兩個點
uv run python -m gpssim.cli route --waypoints "25.03,121.56; 25.04,121.57" --kmh 30
```

它會沿著路線每秒回報一個新位置，跑完印出實測結果：

```
Route playback follows the path: PASS  (0.00 m)
  41 筆位置，最遠偏離 0.0 m，實測速度 30.0 m/s（設定 30.0），heading/speed 有值
```

支援 `.gpx` `.kml` `.geojson` `.json` `.txt` `.csv`；
`--loop --laps 3` 繞圈、`--interval 0.5` 改更新頻率。
圖形介面裡也有同樣的功能，還能中途暫停、繼續。

> **Google Maps 的藍點不會跟著跑。** 實測：路線走完 1152 公尺，測試頁一路收到新座標，
> Maps 的藍點卻停在原地 —— 它不會持續追蹤，還會把位置快取起來。
> 要確認移動真的有效，看上面那行 `Route playback` 或自己開測試頁。

### 讓它開著自己操作（CLI）

想讓瀏覽器一直開著自己操作，用 `start` 代替 `maps`：

```bash
uv run python -m gpssim.cli start --coords "25.033964, 121.564468" --maps
```

按 Enter 就會停止模擬並關掉那個 Chrome。

**注意**：它一定會自己開一個新的 Chrome，不能接管你正在用的那個 ——
Chrome 136 之後為了保護日常 profile 的資料，禁止對預設 profile 開偵錯連線。
所以那個視窗沒有登入你的 Google 帳號。

其他指令與踩過的雷見 [CLAUDE.md](CLAUDE.md)。

---

## 它的極限

- **只有這支程式開的那個 Chrome 有效**。你自己另外開的瀏覽器不受影響
- 那個 Chrome 是全新的 profile，**沒有登入 Google**，而且 `navigator.webdriver` 是 `true`
  —— 認真檢查的網站看得出來這是自動化控制的瀏覽器
- **只換 GPS 座標**。IP、時區、語言都還是你原本的，所以 Google Maps 一開始的視野
  仍會照 IP 猜，要按定位鈕才會跳到你設的位置
- **只支援 Chrome**。Edge / Firefox / Safari 沒做
- **不碰作業系統的定位**，其他 app 看到的還是真實位置

## 給要改程式的人

```bash
uv run python -m gpssim.cli maps --coords "25.033964, 121.564468"   # exit 0 = 三項全 PASS
```

- [CLAUDE.md](CLAUDE.md) — 架構、踩過的雷、開發流程
- [SPEC.md](SPEC.md) — 規格與驗收條件

地址搜尋用 [Nominatim](https://nominatim.openstreetmap.org/)，資料來源
© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors；
它的[使用政策](https://operations.osmfoundation.org/policies/nominatim/)是硬約束
（每秒至多 1 次、必須快取、必須以可識別的 User-Agent 送出、必須標示出處、
不得實作打字即查），相關程式碼集中在 `gpssim/geocode.py`。
