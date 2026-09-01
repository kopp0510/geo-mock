## 下載

| 你的電腦 | 下載 |
|---|---|
| Windows | `GPS-Simulator.exe` |

**要先裝 [Google Chrome](https://www.google.com/chrome/)** —— 這個工具是驅動 Chrome，不自帶瀏覽器。

### 第一次打開會被 Windows 擋

程式沒有付費簽章，所以會跳「已保護您的電腦」→ 點「**其他資訊**」→「**仍要執行**」。
這是因為沒買簽章憑證，不是病毒。

## Mac 請從原始碼跑（沒有下載檔）

Mac 版不提供執行檔。未簽章的 App 下載後會被系統擋掉
（「無法打開，因為 Apple 無法檢查是否包含惡意軟體」），解除要付 Apple 的年費做公證，
發一個多數人打不開的檔案沒有意義。

需要 [Google Chrome](https://www.google.com/chrome/)。打開「終端機」貼上：

```bash
# 裝 uv（Python 的套件管理工具），裝完把終端機關掉重開一次
curl -LsSf https://astral.sh/uv/install.sh | sh

# 抓原始碼並開啟圖形介面
git clone https://github.com/kopp0510/gps-simulator.git
cd gps-simulator
uv sync --extra gui
uv run python -m gpssim.cli gui
```

之後要再開，只要 `cd gps-simulator` 再跑最後那行。
（第一次執行 `git` 時 macOS 會跳出視窗問要不要裝開發者工具，按「**安裝**」，
裝完之後把 `git clone` 那行再跑一次 —— 安裝過程會讓原本那行中斷。）

## 怎麼用

1. 最上面打地名，例如「台北101」，按 **Enter**
2. 點一下查出來的結果，座標會自動填好
3. 按「**開始模擬**」→ 它會開一個 Chrome
4. **在那個 Chrome 視窗裡**上網，網站問你的位置時就會拿到你設的座標
5. 用完按「**停止模擬**」

## 這一版的驗證結果

發布前在 GitHub Actions 上跑過：**Windows 用打包好的執行檔本身**驗、
**macOS 從原始碼**驗，三項全部 PASS —— `navigator.geolocation`、
Google Maps 拿到的座標、Google Maps 的藍點。
