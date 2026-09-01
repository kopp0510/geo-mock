"""啟動一個給 Simulator 專用的 Chrome，並在收工時清乾淨。"""

import os
import shutil
import subprocess
import tempfile
import time

from . import detect


class ChromeLaunchError(RuntimeError):
    pass


class Chrome:
    """獨立 profile 的 Chrome instance。

    **不能附接使用者日常的瀏覽器**：Chrome 136 起，`--remote-debugging-port` 對
    預設 user-data-dir 一律失效（非預設目錄用不同的加密金鑰，等於把日常 profile
    的資料擋在偵錯之外）。所以一定是自己起一個、自己收掉。
    代價是這個 Chrome 沒有登入 Google。
    """

    def __init__(self, executable=None, window_size="1440,900"):
        self.executable = executable or detect.find_chrome()
        if not self.executable:
            raise ChromeLaunchError(
                "找不到 Chrome。設 CHROME_BIN 指到執行檔，或先安裝 Google Chrome。"
            )
        self.window_size = window_size
        self.profile = None
        self.process = None
        self.port = None

    def start(self):
        self.profile = tempfile.mkdtemp(prefix="gpssim-")
        self.process = subprocess.Popen(
            [
                self.executable,
                "--remote-debugging-port=0",      # 0 = 讓 OS 配，埠號寫在 DevToolsActivePort
                f"--user-data-dir={self.profile}",
                "--no-first-run",
                "--no-default-browser-check",
                f"--window-size={self.window_size}",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.port = self._wait_for_port()
        return self

    def stop(self):
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
            self.process = None
        if self.profile:
            shutil.rmtree(self.profile, ignore_errors=True)
            self.profile = None

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()

    def _wait_for_port(self, timeout=30):
        """DevToolsActivePort 是 Chrome 起來之後才寫出來的，一定要 poll。

        單次讀必然偶發失敗——而且失敗時 Chrome 已經開著了，症狀是「視窗跳出來但
        程式說找不到 port」。
        """
        path = os.path.join(self.profile, "DevToolsActivePort")
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.process.poll() is not None:
                raise ChromeLaunchError(f"Chrome 啟動後隨即結束（exit {self.process.returncode}）")
            try:
                with open(path) as f:
                    first_line = f.readline().strip()
            except OSError:
                first_line = ""
            if first_line.isdigit():
                return int(first_line)
            time.sleep(0.1)
        raise ChromeLaunchError(f"等不到 DevToolsActivePort（{timeout} 秒）")
