# providers/ — 「怎麼改掉定位」的抽象與實作

一個 provider = 一種讓瀏覽器回報指定座標的辦法。上層（`verify.py` / `cli.py`）
只認 `base.py` 的介面，換 OS 或換瀏覽器時只加檔案，不動上層。

## 檔案

| 檔案 | 層級 | 現況 |
|---|---|---|
| `base.py` | — | `LocationProvider` 介面：`is_supported()` / `start()` / `stop()`，以及 `Support(ok, reason)` |
| `chrome_cdp.py` | 瀏覽器 | **唯一實作**。CDP `Emulation.setGeolocationOverride` |
| `os_native.py` | OS | 所有平台都回不支援，但每個平台要講得出**具體理由** |
| `extension.py` | 頁面 JS | `../../../extension/` 那個擴充。尚未串接，只有殼 |

`__init__.py` 的 `ORDER` 是計畫的優先順序（OS → CDP → 擴充），
`pick()` 走第一個說自己支援的，全都不支援回 `None`。

## 此層慣例

- **不支援時 `reason` 要能直接顯示給使用者看**，不是內部代號。
  「假裝成功」比「誠實回報不支援」糟糕得多
- **絕對不要用 OS 名稱推論支援與否**。沒實測過就回不支援，理由寫「未實測」
- 新增 provider 就是新增一個檔案 + 加進 `ORDER`，不必動別處

## chrome_cdp.py 的三條硬規則（違反的症狀都很難歸因）

1. **事件處理器只准排隊，不准送指令**。`_on_attached` 是在 `cdp._wait_for()`
   的 recv 迴圈裡被呼叫的，在那當下送指令會重入、把外層在等的回覆吃掉，
   症狀是遠處某個 send 莫名逾時。排進 `_pending`，由 `_flush()` 在迴圈外補送。
   （`cdp._dispatch()` 現在會對這種情況丟 `CDPError`，不讓它再靜默一次）

2. **每個新 session 都要補送 override**。`Emulation.setGeolocationOverride`
   是 per-session；`Target.setAutoAttach` 只讓你看得到新 target，
   **不會**把既有的 override 帶過去。漏了的話新分頁拿到真實位置。

3. **`stop()` 要能重複呼叫、失敗要吞掉**。分頁可能已經關了，
   `clearGeolocationOverride` 清不掉不是錯誤。獨立 profile 整個刪掉之後其實
   不會有殘留，但這裡是唯一的還原點 —— 哪天改成附接既有瀏覽器就靠它。

## 與上層的關係

`chrome_cdp.py` 用 `..cdp` 與 `..chrome`。**不要反過來**讓那兩個模組認識 provider。
