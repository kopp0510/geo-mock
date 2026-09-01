"""把版本號寫進 pyproject.toml 與 gpssim/__init__.py。

只給 CI 用：打 tag `v0.3.0` 時跑 `python set_version.py v0.3.0`，
打包出來的執行檔就會回報那個版本。

**平常不要手動跑。** 版本號的唯一來源是 git tag —— 多一個地方要記得改，
就多一個會忘的地方（這支檔案存在的理由就是那個不一致）。
"""

import pathlib
import re
import sys

VERSION = re.compile(r"^v?(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)$")


def main(raw):
    match = VERSION.match(raw.strip())
    if not match:
        print(f"看不懂的版本字串：{raw!r}（預期像 v1.2.3）", file=sys.stderr)
        return 2
    version = match.group(1)

    edits = [
        ("pyproject.toml", re.compile(r'^version = ".*"$', re.M), f'version = "{version}"'),
        ("gpssim/__init__.py", re.compile(r'^__version__ = ".*"$', re.M),
         f'__version__ = "{version}"'),
    ]
    for path, pattern, replacement in edits:
        file = pathlib.Path(path)
        text = file.read_text(encoding="utf-8")
        new_text, count = pattern.subn(replacement, text)
        if count != 1:
            print(f"{path} 裡找不到版本號那一行（命中 {count} 次）", file=sys.stderr)
            return 1
        file.write_text(new_text, encoding="utf-8")
        print(f"{path} -> {version}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("用法：python set_version.py v1.2.3", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
