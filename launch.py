"""打包成 .exe 用的進入點。

PyInstaller 需要一支真的 script，不吃 `python -m gpssim.gui`，所以有這一支。
平常開發不需要它 —— 直接 `uv run python -m gpssim.cli gui` 就好。
"""

import sys

from gpssim.gui import main

if __name__ == "__main__":
    sys.exit(main())
