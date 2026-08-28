# geo-mock

開發用的 Chrome 定位覆寫擴充。輸入地址或選擇已存地點，讓瀏覽器對任何網站回報指定的
GPS 座標，用來檢視系統在不同區域的呈現結果。通用工具，不綁特定網站。

## 狀態

**開發中** — 尚無可安裝版本。安裝與使用說明會在第一版（固定座標覆寫 + popup 開關）
能跑之後補上。

## 技術

Manifest V3、純原生 JS，無 build 工具。需 Chrome 111+（content script 的 `world` 欄位）。

地址搜尋使用 [Nominatim](https://nominatim.openstreetmap.org/)，資料來源
© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors。

## 文件

- [SPEC.md](SPEC.md) — 功能規格：三種模式、Popup 版面、Geocoding 政策、實作順序
- [CLAUDE.md](CLAUDE.md) — 架構約束、已知陷阱、開發流程
