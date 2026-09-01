"""gpssim —— 跨平台 GPS / Location Simulator。"""

import os
import sys

__version__ = "0.1.0"


def enable_utf8_output():
    """把 stdout / stderr 弄成「印中文不會爆」的狀態。

    兩個坑，都是 Windows 專屬，都會讓程式在第一個 `print` 就死：

    1. **編碼**：Windows 的輸出編碼跟著系統地區設定走（CI 上是 cp1252、
       繁中環境是 cp950），而這支程式的輸出全是中文，會丟
       `UnicodeEncodeError: 'charmap' codec can't encode`。
       實測：Windows CI 的 `detect` 就是這樣掛的，連 Chrome 都還沒開。

    2. **根本沒有 stdout**：PyInstaller 的 `--windowed`（GUI 子系統）exe
       沒有主控台，`sys.stdout` 是 `None`，`print()` 會丟
       `AttributeError: 'NoneType' object has no attribute 'write'`。
       實測：打包版的 `GPS-Simulator.exe detect` 一行都沒印就非零結束。
       導到 devnull 之後，帶參數跑打包版仍然能正確回傳 exit code
       ——**看不到輸出，但結果是對的**。

    `errors="replace"` 是保險：終端機真的吃不下某個字時印成 `?`，
    也比整支程式崩掉好。
    """
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None:
            setattr(sys, name, open(os.devnull, "w", encoding="utf-8"))
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass    # 被重導到不支援 reconfigure 的物件，就維持原樣
