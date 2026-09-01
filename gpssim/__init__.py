"""gpssim —— 跨平台 GPS / Location Simulator。"""

import sys

__version__ = "0.1.0"


def enable_utf8_output():
    """把 stdout / stderr 轉成 UTF-8。

    **Windows 上不做這件事程式會直接崩潰。** 它的預設輸出編碼跟著系統地區設定走
    （CI 上是 cp1252、繁中環境是 cp950），而這支程式的輸出全是中文，
    第一個 `print` 就會丟 `UnicodeEncodeError: 'charmap' codec can't encode`。
    實測：Windows CI 的 `detect` 就是這樣掛的，連 Chrome 都還沒開。

    `errors="replace"` 是保險：萬一終端機真的吃不下某個字，印成 `?` 也比
    整支程式崩掉好 —— 使用者要的是座標，不是完美的排版。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass    # 被重導到不支援 reconfigure 的物件，就維持原樣
