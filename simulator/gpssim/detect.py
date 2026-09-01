"""環境偵測：OS、版本、架構、瀏覽器。

計畫 §17 的重點是**不要**寫成 `if Windows: assume supported`。
這裡只負責如實回報看到了什麼，能不能模擬由各 provider 的 `is_supported()` 自己說。
"""

import os
import platform
import shutil
import subprocess
from dataclasses import dataclass

# 各 OS 的 Chrome 慣用安裝位置。找不到不是錯誤，是「這台機器沒有 Chrome」。
_CHROME_PATHS = {
    "Darwin": [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        os.path.expanduser("~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ],
    "Windows": [
        os.path.join(os.environ.get("PROGRAMFILES", r"C:\Program Files"),
                     "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"),
                     "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""),
                     "Google", "Chrome", "Application", "chrome.exe"),
    ],
    "Linux": [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
    ],
}

_LINUX_ON_PATH = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]


@dataclass
class Environment:
    os_name: str
    os_version: str
    arch: str
    chrome_path: str | None
    chrome_version: str | None

    @property
    def browser(self):
        return self.chrome_version or "（找不到 Chrome）"


def find_chrome():
    """回傳 Chrome 執行檔路徑，找不到回 None。

    `CHROME_BIN` 優先——跟 tools/verify.js 同一個慣例，方便指定特定版本。
    """
    override = os.environ.get("CHROME_BIN")
    if override:
        return override if os.path.exists(override) else None

    system = platform.system()
    for path in _CHROME_PATHS.get(system, []):
        if path and os.path.exists(path):
            return path

    # Linux 的發行版路徑差異太大，退回 PATH 搜尋。
    if system == "Linux":
        for name in _LINUX_ON_PATH:
            found = shutil.which(name)
            if found:
                return found
    return None


def chrome_version(path):
    """跑 `--version` 拿版本字串。拿不到回 None，不丟例外。"""
    if not path:
        return None
    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return None
    return (out.stdout or out.stderr).strip() or None


def detect():
    system = platform.system()
    if system == "Darwin":
        version = platform.mac_ver()[0] or platform.release()
    elif system == "Windows":
        version = platform.version()
    else:
        version = platform.release()

    path = find_chrome()
    return Environment(
        os_name=system or "Unknown",
        os_version=version,
        arch=platform.machine(),
        chrome_path=path,
        chrome_version=chrome_version(path),
    )
