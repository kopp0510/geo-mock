"""打包成單一執行檔用的進入點。

PyInstaller 需要一支真的 script，不吃 `python -m gpssim.gui`，所以有這一支。
平常開發不需要它 —— 直接 `uv run python -m gpssim.cli gui` 就好。

**帶參數就走 CLI，不帶就開 GUI。** 這不是為了方便，是為了讓打包出來的東西
驗得動：`GPS-Simulator detect` 或 `GPS-Simulator maps --coords ...` 跑得過，
才證明資源檔（測試頁）真的被打包進去、路徑也解得對。
只能開 GUI 的話，打包壞掉只能靠人眼發現。
"""

import sys

if __name__ == "__main__":
    if len(sys.argv) > 1:
        from gpssim.cli import main
        sys.exit(main())
    from gpssim.gui import main
    sys.exit(main())
