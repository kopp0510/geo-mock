# geo-mock

開發用的 Chrome 定位覆寫擴充。輸入地址或選已存地點，讓瀏覽器對任何網站回報指定的
GPS 座標，用來檢視系統在不同區域的呈現結果。通用工具，不綁特定網站。

**完整規格見 [SPEC.md](SPEC.md)** — 三種模式行為、Popup 面板版面、Nominatim 使用政策、
三版實作優先順序。本檔只放每輪都該遵守的約束與慣例。

## 技術棧

Manifest V3、純原生 JS。無 build 工具、無套件管理器、無測試框架。

## 目錄結構

```
geo-mock/
├─ README.md          # 對外簡介、安裝與使用說明
├─ SPEC.md            # 功能規格
├─ CLAUDE.md          # 本檔：架構約束與開發流程
├─ manifest.json
├─ defaults.js        # 設定預設值，bridge/options/verify 三方共用的唯一一份
├─ inject.js          # world: MAIN, run_at: document_start — 實際覆寫 geolocation
├─ bridge.js          # world: ISOLATED, run_at: document_start — 讀 storage 推給 inject
├─ sites.js           # 排除清單的比對規則。content script 與擴充頁共用一份
├─ i18n.js            # 介面文字（繁中／英文）與套用到 DOM 的工具。popup/options/SW 共用
├─ _locales/          # 只放 manifest 的擴充描述；介面文字不走這裡（見架構約束）
├─ background.js      # service worker。唯一任務：代 popup 執行地址查詢
├─ geocode.js         # Nominatim 查詢、快取、每秒 1 次閘門。由 background.js importScripts
├─ rules.json         # declarativeNetRequest 規則：送 Nominatim 前改寫 User-Agent
├─ popup.html / popup.js       # 啟用開關、地址搜尋、模式切換（固定／抖動）、
│                             #   目前座標一覽、已存地點 chips、進階設定連結
├─ options.html / options.js   # 座標與抖動半徑。最上面的「貼上座標」欄接 Google Maps
│                             #   右鍵複製的「緯度, 經度」整串，拆進下面兩欄
├─ icons/16.png 48.png 128.png
└─ tools/             # 驗證腳本，不會被打包進擴充（見 tools/CLAUDE.md）
```

## 架構約束（已定案，不重新討論）

- 覆寫對象是 `navigator.geolocation`，必須跑在頁面自己的 JS 環境
- **兩個 content script 都要 `all_frames: true`**：iframe 有自己的 JS 環境，
  漏了其中一個的症狀是「主頁面正常、嵌在裡面的地圖顯示真實位置」，很難歸因。
  `tools/verify.js` 第 3 項守著（測試頁嵌了 `fixtures/frame.html`）
- **雙 content script 不可合併**：MAIN world 拿不到 `chrome.storage`，所以由
  ISOLATED world 的 `bridge.js` 讀設定、用 CustomEvent 推給 MAIN world 的 `inject.js`
- **跨 world 的事件帶遞增序號**：`{ seq, settings }`，`inject.js` 只接受嚴格大於
  已收到的 seq。`storage.onChanged` 的即時推送與 READY 握手的補送會交錯，
  沒有序號的話舊設定後到就把新的蓋掉。序號擋的是自家的亂序，**擋不住頁面偽造**
  （見「已知限制」）
- **`bridge.js` 的 `WATCHED` 從 `GEO_MOCK_DEFAULTS` 派生，不可手抄**：漏了新欄位
  會讓「改那個欄位不會即時生效」靜默發生，而 UI 五處都寫著即時生效。
  例外用 `NOT_WATCHED` 扣掉，每一個都要寫理由（目前是 `places` 與 `locale`，
  兩者都只有擴充自己的頁面用得到，理由寫在 `bridge.js` 那幾行）。`geocodeCache` / `geocodeLastAt` 不在 defaults
  裡，本來就不會被派生進來
- **「要監看」與「要送出」是兩件事**（`bridge.js`）：`WATCHED` 決定哪些鍵變動要
  推送，`SENT`（扣掉 `NOT_SENT`）決定送什麼過去。`excludedSites` 必須監看
  —— 把目前這個站加進清單時該分頁要立刻停止覆寫 —— 但**不能送**：那是一份
  使用者關心哪些網站的清單，頁面讀得到等於白送一份瀏覽偏好
- **推送出去的內容只有 `SENT` 那幾個鍵**（`bridge.js` 的 `pick()`），不是整份
  設定。這個事件頁面監聽得到，整份送的話已存地點連同精確座標會被每個網站讀走。
  `tools/verify.js` 第 10 項守著這條 —— 拿掉過濾功能完全正常，沒有任何症狀
- manifest 的 `content_scripts` 用 `world` 欄位需要 Chrome 111+
- **ISOLATED world 是多檔載入，順序有語意依賴**：`["defaults.js", "sites.js", "bridge.js"]`，
  `defaults.js` 必須排在前面。順序反了或檔案漏掉，`bridge.js` 會拿不到
  `GEO_MOCK_DEFAULTS`；那條路徑現在會 `console.error` 並退回真實定位，不會靜默失效
- `manifest.json` 需 `host_permissions: ["https://nominatim.openstreetmap.org/*"]`
- **介面文字用自己的字串表（`i18n.js`），不用 `chrome.i18n` 的 `_locales`**：那套
  跟隨的是瀏覽器 UI 語言，擴充**沒辦法**在執行時切換。這是開發工具，想看英文介面
  不該逼人去改整台瀏覽器的語言。`_locales/` 只留給 manifest 的描述，那個 Chrome
  只認原生機制
- **`manifest.json` 的 `name` 不可以用 `__MSG_...__`**：`tools/verify.js` 的
  `makeNoBridgeVariant()` 會把 `name` 抄進變體 manifest，而變體目錄沒有 `_locales`，
  Chrome 會整個拒絕載入它 —— 最後一項會用「變體沒載入」這個跟真正問題無關的理由失敗。
  第 1 項靜態斷言守著這條
- **`inject.js` 的 console 訊息固定用中文，不做 i18n**：它跑在 MAIN world，拿不到
  字串表也拿不到 storage。要翻譯就得把譯文塞進推送的設定裡，不值得
- **地址查詢必須跑在 service worker，不能搬回 popup**：popup 點到外面就整個銷毀，
  查詢途中被關掉的話結果寫不進快取，重開再查同一個字串就是第二次相同請求 ——
  政策列為 faulty client 的行為。搬回去照樣有搜尋結果，測不出來，
  所以 `tools/verify.js` 第 1 項用靜態檢查守著（manifest 有沒有註冊 SW、
  popup.html 有沒有又直接載入 `geocode.js`）
- **Nominatim 的 User-Agent 只能靠 declarativeNetRequest 改**：`fetch` 設不了這個
  header（瀏覽器禁止），擴充頁也不送 `Referer`，兩條識別路徑都空的。`rules.json` 的
  靜態規則在網路層改寫，實測有效（見 SPEC.md）。刪掉那條規則 = 直接違反政策。
  權限用 `declarativeNetRequestWithHostAccess` 而非 `declarativeNetRequest`：
  兩者對這條規則的效果實測相同（都改得到），但後者會在安裝時多跳一個權限警告，
  而規則只作用在已有 host permission 的網域上，付那個代價換不到任何能力。
  **改動這裡務必用 CDP 的 `requestWillBeSentExtraInfo` 重驗**——DNR 規則失效是
  靜默的，沒有 console 錯誤，搜尋照樣有結果

## 不要做的事

- 不引入 build 工具、TypeScript、React
- 第一版不做地圖 picker（Leaflet 要打包進擴充，體積和複雜度大一個量級）
- 不為了通用性預先實作沒撞到的相容處理
- 不擅自跳過 SPEC.md 的三版優先順序去做第三版項目

## 已知陷阱（寫 code 前先看）

1. **時序**：`chrome.storage.local.get` 是非同步，頁面可能在設定送達前就呼叫定位 API。
   `inject.js` 要把請求排隊，等設定到達再回應。**這段不能省。**

2. **`watchPosition` 必須同步回傳 watch id**，不能等設定載入才回。已實作：
   `inject.js` 自己維護計數器當 id（從 1000000 起跳，避開與原生 id 碰撞），
   位置靠 `setInterval` 送。設定還沒到時**不能排隊等**——id 現在就得回傳，
   所以改成先發 id、位置晚點再送，並用一道逾時保證設定永遠不來時 watch 會被
   交回原生，不讓呼叫端無聲等一輩子。`applyWatch()` 是唯一決定「怎麼送」的地方，
   設定每次變更都會重跑它，所以它必須能從任何狀態切到任何狀態。

3. **`navigator.permissions.query({name:'geolocation'})`** — 有些網站先查權限，看到
   prompt 就不呼叫定位了。**已實作**於 `inject.js`：只攔 geolocation，其他權限
   原樣轉給原生；覆寫沒開時也轉回原生（回 granted 會讓網站以為拿得到位置，
   結果原生跳出授權對話框）。

4. **回傳的是普通物件**，不是真的 `GeolocationPosition`。少數網站會檢查 prototype 或
   `instanceof`。第三版再處理。

5. **jitter 以「設定的座標」為中心抖動**，不是以真實位置為中心。
   已實作在 `inject.js` 的 `jitterCoords()`：每次呼叫重新抖，圓盤上均勻取點
   （半徑要開根號，否則點會擠在圓心），極點附近 `cos(緯度)` 夾了下限免得
   經度偏移炸成天文數字。`mode` 預設 **必須**是 `'fixed'` —— 好幾項驗證斷言
   比對的是精確座標。

6. **Nominatim 使用政策是硬約束**（政策原文逐條抄在 SPEC.md）：每秒至多 1 次、
   必須快取、必須可識別、必須標出處，而且 **auto-complete 是明文禁止的**——
   搜尋只由 Enter 或搜尋鈕觸發，`input` 事件只用來清掉對不上的舊清單，**不查詢**。
   把打字即查加回去等於自找封鎖，跟 debounce 多長無關。
   規定兌現在 `geocode.js` + `rules.json`（出處那行在 `popup.html` 的 `.attrib`）。
   **要打 Nominatim 一律經過 `geocode.js`**，別在別的地方另開 fetch——
   速率閘門與去重都是模組內的狀態，繞過去就等於沒有。同理，`tools/verify.js` 刻意
   不驗地址搜尋：自動化重複請求正是政策禁止的，這段只做手動驗證。

7. **service worker 裡讀 storage，要等 callback 才做事**。SW 隨時會被回收重啟，
   記憶體裡的狀態留不住，而 `chrome.storage.local.get` 是非同步的 —— 把後續動作
   留在 callback 外面同步跑完的話，**重啟後的第一次操作一律走預設值**。
   實測踩過一次：語系讀取寫在外面，SW 重啟後第一次搜尋的錯誤訊息、送出的
   `accept-language`、寫進去的快取鍵三者全是英文，而使用者選的是繁中。

## 開發流程（每個功能段落依序走）
<!-- dd-loop-version: 6step；供 /dd-init 判斷是否提議升級，勿刪 -->

1. **實作功能 + 首輪測試通過**（本專案無測試框架 → 退化為「擴充能載入且手動走過該功能」，
   不可帶紅燈進 commit）
2. **commit**（第一次 — 保留簡化前還原點）
3. 跑 **code-simplifier**（對該段新增/修改的程式碼，官方 agent）
4. 跑 **code-review**（該段 diff，每段全量跑；修掉 Critical/Important 才續行）
5. **再測一次** — 確認步驟 3、4 沒破壞行為：
   - `node tools/verify.js` —— exit 0 才算過。它會開真實瀏覽器載入未封裝擴充，
     斷言覆寫生效、請求排隊、以及設定永不到達時不會懸掛（細節見 tools/CLAUDE.md）
   - **只能用 Chrome for Testing。系統的 Chrome stable 不行** —— 151 實測已忽略
     `--load-extension`，擴充根本不載入，而且沒有任何錯誤訊息，很容易誤判成程式有 bug
   - 手動確認時：`chrome://extensions` → 開發者模式 → 重新載入該擴充，
     檢查 content script 的 console 無錯誤
   - 改到 popup / options UI 時截圖，一律存 `.screenshots/`（已 gitignore），
     勿丟專案根目錄
   - 改到 geocoding 時：`curl -A 'geo-mock/1.0' 'https://nominatim.openstreetmap.org/search?format=json&q=<地址>'`
     驗證 API 實際回應（識別要求已用 declarativeNetRequest 解掉，見 SPEC.md
     「識別要求怎麼滿足的」；那條「未解事項」已結案）

6. **再 commit**（最終版本）

驗證不過 → 修完重跑步驟 5，不可帶著紅燈進步驟 6。

## 已知限制（review 提出，刻意不修，別當成 bug 重查）

- **覆寫可被頁面看穿也可被關掉**：`geo-mock:settings` / `geo-mock:ready` 是 document
  上的普通 CustomEvent，頁面自己的 JS 能監聽（讀到你設的座標）也能偽造
  （送一個帶大序號的 `{"enabled":false}` 就關掉覆寫）。能讀到的只有 `WATCHED`
  那幾個鍵 —— 已存地點不在推送內容裡，見「架構約束」。跨 world 沒有私密通道可用，
  這是架構的必然代價。**在會偵測 location spoofing 的網站上測不出預期結果時，
  先想到這條。** 事件協定的 `seq` 是為了擋自家的亂序而加的，對惡意偽造沒有幫助 ——
  頁面送一個很大的 seq 就能把後續真正的更新全部擋在門外。
- **`getCurrentPosition` 可被繞過**：覆寫是實例上的賦值，
  `Geolocation.prototype.getCurrentPosition.call(navigator.geolocation, ...)` 走的是原生。
  同樣屬 SPEC 陷阱 4 的範圍，第三版再處理。
- **設定送不到時最壞花掉呼叫端 timeout 的兩倍**：見 `inject.js` 逾時分支的註解。
  極端路徑，正常情況設定 20ms 內就到。有了即時推送之後這不再是終端狀態 ——
  設定晚到會帶著更大的序號把它接回去。
- **重新載入擴充之後，開著的分頁要重整一次才恢復即時推送**。Chrome 不會把
  content script 重新注入既有分頁，而是把舊的孤兒化（「Extension context
  invalidated」的由來），孤兒 `bridge.js` 收不到 `storage.onChanged`。
  **這正好是本專案開發迴圈步驟 5 的預設路徑**（重新載入擴充 → 回到開著的測試頁
  → 改設定 → 沒反應），第一次撞到很容易誤判成即時推送壞了。`bridge.js` 的
  `onChanged` callback 有自己的 try/catch，這種情況會在該分頁的 console 印一行。
- **`seq` 是在「送出時」取號，不是「讀取時」**（`bridge.js`）。兩次快速寫入會發出
  兩次非同步 `get`，callback 若亂序回來，後到的那個會拿到較大的序號卻帶著較舊的
  快照，inject 就停在舊設定直到下次變更才自癒。Chrome 的 storage callback 實務上
  是循序的，所以這是理論風險；真要修得把 `cached` 與它的序號綁在一起走，
  光是「先取號再讀」不夠 —— 陳舊的讀取仍會覆寫 `cached`，之後 READY 補送就會
  廣播那份陳舊快照。
- **「查詢結果沒進快取就重送」仍有兩個窄窗口**，刻意不處理。日常那條路徑
  （搜尋途中點掉 popup）已經在把查詢搬進 service worker 時修好了，剩下的是：
  SW 在 fetch 途中被**強制**終止（`chrome://extensions` 按重新載入、擴充更新、
  瀏覽器關閉、記憶體壓力下被回收 —— 不含閒置逾時，那條被 `gate()` 與 `cachePut()`
  的 storage 呼叫擋住了），以及 `cachePut` 自己失敗（storage 配額用盡，那條是
  刻意吞掉的）。兩者結果相同：下次查同一個字串重送一次請求。
  記在這裡是為了讓下一輪 review 不用再挖一次。
- **jitter 模式下 `watchPosition` 的重送間隔寫死 1 秒**（`JITTER_INTERVAL_MS`），
  沒有做成設定項。要模擬更快或更慢的移動就得改碼。
- **`all_frames` 的扇出成本與暴露面**：廣告密集的頁面有數十個 frame，每個都會
  載入四支 content script、各發一次 `storage.get`、各註冊一個 `onChanged`；
  改一次座標等於 N 次設定重讀加 N 次事件廣播。而且第三方 frame 現在也收得到
  `geo-mock:settings`（含座標），即使它從沒呼叫過定位 API —— 「頁面能監聽
  CustomEvent」那條限制的暴露面確實變大了。
- **排除清單的萬用字元不吃埠號**：`*.example.com` 命中 `sub.example.com`，
  但**不**命中 `sub.example.com:3000`，要另外寫 `*.example.com:3000`。
  非萬用字元那條反而是含埠號比對的，兩者不對稱。
- **Permissions Policy 拒絕的 frame 裡仍回 granted**：`allow=""` 的跨來源 iframe
  原生會回 `denied`，覆寫直接回 granted 而且 `getCurrentPosition` 也真的給座標。
  對開發工具來說多半是想要的，但與「覆寫沒開就轉回原生」那條原則不完全一致。
- **popup 的一鍵排除只有手動走查涵蓋**：`tools/verify.js` 把 popup 當一般分頁開，
  protocol 是 `chrome-extension:` → 拿不到 host → 那顆按鈕與 `data-state="excluded"`
  這個第三種值都走不到。要驗得手動開 popup。
- **預設 `enabled: true`，裝上就對所有網站生效**。task 3 加了 popup 開關之後重新
  檢討過，決定維持開啟：載入未封裝擴充本身就是明確的開發意圖，再要求「裝完還要
  手動打開」對開發工具是多餘的一步。代價是忘了關的話每個網站都在回報設定座標，
  唯一線索是 `inject.js` 首次覆寫時印的那行 `console.info`。
  若要改成 opt-in，`tools/verify.js` 第 2～12 項需先經 popup 打開開關才能跑。

## CLAUDE.md 維護

- 每個有程式碼的資料夾都要有 CLAUDE.md（說明該層職責與慣例）
- 功能落地後，受影響目錄的 CLAUDE.md 逐層堆疊更新
  （用 claude-md-management plugin 的 /revise-claude-md 或手動）
- SPEC.md 的決策若在實作中被推翻（例如 Nominatim 擋擴充、改用 LocationIQ），
  同批更新 SPEC.md，不要讓規格與實作分岔
