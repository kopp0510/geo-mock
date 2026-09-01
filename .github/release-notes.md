## 下載

| 你的電腦 | 下載 |
|---|---|
| Windows | `GPS-Simulator.exe` |
| Mac（M1／M2／M3 以後） | `GPS-Simulator-macos-arm64.zip` |
| Mac（2020 以前的 Intel 機種） | `GPS-Simulator-macos-intel.zip` |

**都需要先裝 [Google Chrome](https://www.google.com/chrome/)** —— 這個工具是驅動 Chrome，不自帶瀏覽器。

## 第一次打開會被系統擋

程式沒有付費簽章，所以：

- **Windows**：跳「已保護您的電腦」→ 點「**其他資訊**」→「**仍要執行**」
- **Mac**：解壓縮後，**在 App 上按右鍵 →「打開」**（直接雙擊會被擋），再點一次「打開」

## 怎麼用

1. 最上面打地名，例如「台北101」，按 **Enter**
2. 點一下查出來的結果，座標會自動填好
3. 按「**開始模擬**」→ 它會開一個 Chrome
4. **在那個 Chrome 視窗裡**上網，網站問你的位置時就會拿到你設的座標
5. 用完按「**停止模擬**」

## 這一版的驗證結果

Windows 與 macOS 都是用**打包好的執行檔本身**跑過驗證才發布的，
三項全部 PASS：`navigator.geolocation`、Google Maps 拿到的座標、Google Maps 的藍點。
