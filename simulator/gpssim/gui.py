"""PySide6 介面。

計畫 §19 第三階段：前兩個 Milestone 綠燈之後才做這一層。
它不做任何 CLI 做不到的事，只是把 `cli._run` 那條路徑接到按鈕上。

**所有會阻塞的動作都在 worker thread**：CDP 是同步 socket 呼叫，
放在 UI thread 會讓整個視窗在啟動 Chrome 的那幾秒鎖死。
"""

import sys
import threading

from PySide6.QtCore import QObject, QThread, Signal
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QGridLayout, QHBoxLayout, QLabel, QLineEdit,
    QMainWindow, QPlainTextEdit, QPushButton, QVBoxLayout, QWidget,
)

from . import detect, providers, report, verify
from .coords import InvalidCoordinate, parse_pair, validate
from .providers.chrome_cdp import ChromeCdpProvider
from .server import TestPageServer

from .cli import LIMITATIONS, SHOTS_DIR

DEFAULT_LAT = "25.033964"
DEFAULT_LNG = "121.564468"


class SimulationWorker(QObject):
    """在自己的 thread 裡跑完整輪模擬，並在收到停止訊號前保持瀏覽器開著。

    provider 從建立到 `stop()` 全都在這個 thread 上 —— CDP 的 WebSocket
    不是 thread-safe，從 UI thread 呼叫 `stop()` 會跟正在等回覆的 recv 撞在一起。
    """

    status = Signal(str)
    report_ready = Signal(str)
    failed = Signal(str)
    stopped = Signal()

    def __init__(self, lat, lng, with_maps):
        super().__init__()
        self.lat, self.lng, self.with_maps = lat, lng, with_maps
        self._stop = threading.Event()

    def request_stop(self):
        """由 UI thread 呼叫。只是掀旗子，實際收拾仍在 worker thread。"""
        self._stop.set()

    def run(self):
        environment = detect.detect()
        provider = ChromeCdpProvider()
        support = provider.is_supported()
        if not support:
            self.failed.emit(support.reason)
            self.stopped.emit()
            return

        checks = []
        try:
            self.status.emit("正在啟動專用的 Chrome…")
            provider.start(self.lat, self.lng)

            self.status.emit("正在驗證 navigator.geolocation…")
            with TestPageServer() as server:
                checks.append(verify.verify_test_page(provider, server, (self.lat, self.lng)))

            if self.with_maps and checks[0].passed:
                self.status.emit("正在開 Google Maps 並按下定位鈕…")
                checks.extend(verify.verify_google_maps(
                    provider, (self.lat, self.lng), shots_dir=SHOTS_DIR))

            self.report_ready.emit(report.render(
                environment, provider, support, checks, LIMITATIONS,
                next_step="按「停止模擬」收掉這個 Chrome"))
            self.status.emit("模擬進行中 —— 那個 Chrome 視窗裡的定位就是你設的座標")

            # 撐在這裡讓瀏覽器保持開著，直到使用者按停止。
            while not self._stop.wait(0.2):
                pass
        except Exception as e:
            self.failed.emit(f"{type(e).__name__}: {e}")
        finally:
            # 計畫 §13：不管怎麼結束都要還原，不能讓環境停在假位置。
            provider.stop()
            self.stopped.emit()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("GPS Simulator")
        self.thread = None
        self.worker = None
        self._build()
        self._check_environment()

    # ---- 版面 ----------------------------------------------------------

    def _build(self):
        self.lat = QLineEdit(DEFAULT_LAT)
        self.lng = QLineEdit(DEFAULT_LNG)
        # 貼上「25.033964, 121.564468」整串時自動拆進兩欄 ——
        # Google Maps 右鍵複製出來就是這個格式，跟擴充的 options 頁行為一致。
        #
        # 用 editingFinished 而不是 textChanged：後者會在打字打到一半就拆。
        # 手動輸入「25.033964, 1」的當下 parse 就成功了，欄位會被就地改寫成
        # lat=25.033964 / lng=1，游標留在緯度欄，接著打的字全接到緯度後面。
        # 貼上之後直接按開始鈕的情況由 start() 再叫一次補上。
        self.lat.editingFinished.connect(self._maybe_split)

        self.with_maps = QCheckBox("同時開 Google Maps 驗證（會多花約 20 秒）")
        self.with_maps.setChecked(True)

        self.start_button = QPushButton("開始模擬")
        self.start_button.clicked.connect(self.start)
        self.stop_button = QPushButton("停止模擬")
        self.stop_button.clicked.connect(self.stop)
        self.stop_button.setEnabled(False)

        self.status = QLabel("準備就緒")
        self.status.setWordWrap(True)

        self.output = QPlainTextEdit()
        self.output.setReadOnly(True)
        self.output.setPlaceholderText("驗證結果會顯示在這裡")
        self.output.setStyleSheet("font-family: Menlo, Consolas, monospace;")

        grid = QGridLayout()
        grid.addWidget(QLabel("緯度 Latitude"), 0, 0)
        grid.addWidget(self.lat, 0, 1)
        grid.addWidget(QLabel("經度 Longitude"), 1, 0)
        grid.addWidget(self.lng, 1, 1)

        buttons = QHBoxLayout()
        buttons.addWidget(self.start_button)
        buttons.addWidget(self.stop_button)
        buttons.addStretch()

        layout = QVBoxLayout()
        layout.addLayout(grid)
        layout.addWidget(self.with_maps)
        layout.addLayout(buttons)
        layout.addWidget(self.status)
        layout.addWidget(self.output, stretch=1)

        central = QWidget()
        central.setLayout(layout)
        self.setCentralWidget(central)
        self.resize(620, 520)

    def _maybe_split(self):
        text = self.lat.text()
        if "," not in text:
            return
        try:
            lat, lng = parse_pair(text)
        except InvalidCoordinate:
            return
        self.lat.setText(f"{lat:.6f}".rstrip("0").rstrip("."))
        self.lng.setText(f"{lng:.6f}".rstrip("0").rstrip("."))

    # ---- 環境 ----------------------------------------------------------

    def _check_environment(self):
        """啟動時就把 capability 攤開來（計畫 §3、§17）。

        全都不支援時直接照 §4 第三優先的字面訊息顯示，不留一顆按得下去卻必然失敗的按鈕。
        """
        environment = detect.detect()
        # survey() 已經問過每個 provider 了，重覆問一次等於再跑一次 chrome --version。
        survey = providers.survey()
        self.output.setPlainText(report.render_survey(environment, survey))
        cdp_support = next(s for cls, s in survey if cls is ChromeCdpProvider)
        if not cdp_support:
            self.start_button.setEnabled(False)
            self._set_status(
                "Location simulation is not supported on this environment.", error=True)

    def _set_status(self, text, error=False):
        self.status.setText(text)
        self.status.setStyleSheet("color: #c5221f;" if error else "")

    # ---- 動作 ----------------------------------------------------------

    def start(self):
        self._maybe_split()   # 貼完整串直接按開始、沒離開欄位的情況
        try:
            lat, lng = validate(self.lat.text(), self.lng.text())
        except InvalidCoordinate as e:
            self._set_status(str(e), error=True)
            return

        self.start_button.setEnabled(False)
        self.stop_button.setEnabled(True)
        self.lat.setEnabled(False)
        self.lng.setEnabled(False)
        self.output.clear()
        self._set_status("啟動中…")

        self.worker = SimulationWorker(lat, lng, self.with_maps.isChecked())
        self.thread = QThread(self)
        self.worker.moveToThread(self.thread)
        self.thread.started.connect(self.worker.run)
        self.worker.status.connect(self._set_status)
        self.worker.report_ready.connect(self.output.setPlainText)
        self.worker.failed.connect(lambda m: self._set_status(m, error=True))
        self.worker.stopped.connect(self._on_stopped)
        self.thread.start()

    def stop(self):
        self.stop_button.setEnabled(False)
        self._set_status("正在停止並還原…")
        if self.worker:
            self.worker.request_stop()

    def _on_stopped(self):
        self.thread.quit()
        self.thread.wait()
        self.thread = None
        self.worker = None
        self.start_button.setEnabled(True)
        self.stop_button.setEnabled(False)
        self.lat.setEnabled(True)
        self.lng.setEnabled(True)
        if not self.status.text().startswith("正在"):
            return
        self._set_status("已停止，環境已還原")

    def closeEvent(self, event):
        """關視窗等於停止模擬 —— 不能讓 Chrome 跟 temp profile 留在系統上。"""
        if self.worker:
            self.worker.request_stop()
            self.thread.quit()
            self.thread.wait(15000)
        event.accept()


def main(argv=None):
    app = QApplication(argv or sys.argv[:1])
    app.setApplicationName("GPS Simulator")
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
