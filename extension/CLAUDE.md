# extension/ — geo-mock Chrome 擴充

在頁面的 JS 環境裡覆寫 `navigator.geolocation`，讓瀏覽器對任何網站回報指定座標。
裝在使用者**日常的 Chrome** 上，所有分頁都生效。

這一層原本在 repo 根目錄，simulator 進來之後搬進來，**程式碼行為完全沒動**。

## 它在 Simulator 裡的定位

repo 現在有兩種 location provider（見 `../simulator/gpssim/providers/`）：

| provider | 這一層 | 現況 |
|---|---|---|
| `ChromeCdpProvider` | 瀏覽器內部（Blink） | 預設，唯一實作 |
| **`ExtensionProvider`（就是這個擴充）** | 頁面 JS | **Simulator 還沒接上**，只能手動安裝使用 |

它補的是 CDP 唯一的缺點：CDP 一定要自己起獨立 profile 的 Chrome（Chrome 136 起的
限制），那個瀏覽器沒登入 Google；擴充則是直接用你日常那個。
代價是覆寫可被頁面看穿也繞得過（見下方「已知限制」），所以排在 CDP 後面。

## 檔案

```
manifest.json    # MV3。content_scripts 用 world 欄位，需 Chrome 111+
defaults.js      # 設定預設值，bridge/options/verify 三方共用的唯一一份
inject.js        # world: MAIN, run_at: document_start — 實際覆寫 geolocation
bridge.js        # world: ISOLATED — 讀 storage 推給 inject
sites.js         # 排除清單的比對規則。content script 與擴充頁共用
i18n.js          # 介面文字（繁中／英文）。popup/options/SW 共用
_locales/        # 只放 manifest 的擴充描述；介面文字不走這裡
background.js    # service worker。唯一任務：代 popup 執行地址查詢
geocode.js       # Nominatim 查詢、快取、每秒 1 次閘門
rules.json       # declarativeNetRequest：送 Nominatim 前改寫 User-Agent
popup.*          # 開關、地址搜尋、模式切換、已存地點、排除本站、語言
options.*        # 座標與抖動半徑、排除清單編輯器
icons/
```

## 架構約束

完整清單在 `../CLAUDE.md` 的「擴充的架構約束」。這裡只提最容易踩的三條：

- **雙 content script 不可合併**：MAIN world 拿不到 `chrome.storage`
- **兩個 content script 都要 `all_frames: true` 與 `match_about_blank: true`**
- **推送出去的只有 `SENT` 那幾個鍵**，不是整份設定 —— 頁面監聽得到那個事件

## 驗證

```bash
node ../tools/verify.js    # exit 0 = 十四項斷言全過
```

**只能用 Chrome for Testing**，系統的 Chrome stable 自 151 起已忽略 `--load-extension`。
Simulator 那條路沒有這個限制（CDP 不需要載入擴充），別把兩者的前提搞混。

## 與上層的關係

`../tools/verify.js` 用 `EXT_DIR = <repo>/extension` 指到這裡，並 `require` 這裡的
`defaults.js` 共用同一份預設值。搬動這層的檔案要同步改那邊的路徑常數。
