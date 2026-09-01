"""PySide6 介面。

計畫 §19 第三階段：前兩個 Milestone 綠燈之後才做這一層。
它不做任何 CLI 做不到的事，只是把 `cli._run` 那條路徑接到按鈕上。

**所有會阻塞的動作都在 worker thread**：CDP 是同步 socket 呼叫，
放在 UI thread 會讓整個視窗在啟動 Chrome 的那幾秒鎖死。
"""

import os
import sys
import threading
import time

from PySide6.QtCore import QObject, QThread, Signal
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QDoubleSpinBox, QFileDialog, QGridLayout, QGroupBox,
    QHBoxLayout, QLabel, QLineEdit, QListWidget, QMainWindow, QPlainTextEdit,
    QPushButton, QVBoxLayout, QWidget,
)

from . import detect, formats, geocode, providers, report, verify
from .coords import InvalidCoordinate, parse_pair, validate
from .formats import RouteFileError
from .player import RoutePlayer
from .route import Route, RouteError
from .providers.chrome_cdp import ChromeCdpProvider
from .server import TestPageServer

from .cli import LIMITATIONS, SHOTS_DIR

DEFAULT_LAT = "25.033964"
DEFAULT_LNG = "121.564468"


class SearchSignals(QObject):
    """地址查詢跑在普通執行緒上，結果靠 signal 送回 UI thread。

    查一次要好幾秒（Nominatim 在國外），放在 UI thread 會整個凍住。
    """
    done = Signal(list)
    failed = Signal(str)


class SimulationWorker(QObject):
    """在自己的 thread 裡跑完整輪模擬，並在收到停止訊號前保持瀏覽器開著。

    provider 從建立到 `stop()` 全都在這個 thread 上 —— CDP 的 WebSocket
    不是 thread-safe，從 UI thread 呼叫 `stop()` 會跟正在等回覆的 recv 撞在一起。
    """

    status = Signal(str)
    report_ready = Signal(str)
    failed = Signal(str)
    stopped = Signal()

    def __init__(self, lat, lng, with_maps, route=None):
        super().__init__()
        self.lat, self.lng, self.with_maps = lat, lng, with_maps
        self.route = route
        self.player = None
        self._stop = threading.Event()

    def request_stop(self):
        """由 UI thread 呼叫。只是掀旗子，實際收拾仍在 worker thread。"""
        self._stop.set()

    def _play_route(self, provider):
        """播放路線。進度直接更新狀態列 —— on_fix 跑在 player 自己的執行緒上，
        只發 signal（Qt 會排隊送回 UI thread），不要在那裡直接碰 widget。"""
        total = self.route.total_distance

        def on_fix(fix):
            self.status.emit(
                f"路線播放中 {fix.distance:.0f}/{total:.0f} m"
                f"（{fix.speed:.1f} m/s，方位 {fix.heading:.0f}°）")

        self.player = RoutePlayer(provider, self.route, on_fix=on_fix).start()
        while self.player.state in ("running", "paused"):
            if self._stop.is_set():
                self.player.stop()
                return
            time.sleep(0.1)
        self.status.emit(f"路線播放結束（{self.player.sent} 筆位置）")

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

            if self.route and checks[0].passed:
                self._play_route(provider)

            if self.with_maps and checks[0].passed:
                self.status.emit("正在開 Google Maps 並按下定位鈕…")
                checks.extend(verify.verify_google_maps(
                    provider, (self.lat, self.lng), shots_dir=SHOTS_DIR))

            self.report_ready.emit(report.render(
                environment, provider, support, checks, LIMITATIONS,
                next_step="按「停止模擬」收掉這個 Chrome"))
            # 這一行是整輪的最後狀態，會蓋掉 _play_route 的收尾訊息 ——
            # 所以跑過路線時要講路線的結局，不然畫面上看不出播完了沒。
            if self.route:
                self.status.emit(
                    f"路線播放結束（送出 {self.player.sent} 筆位置）"
                    f"—— Chrome 停在終點，按「停止模擬」收掉")
            else:
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
        self.waypoints = None
        self.route_path = None
        self._build()
        self._check_environment()

    # ---- 版面 ----------------------------------------------------------

    def _build(self):
        # ---- 地址搜尋 ----
        self.search_box = QLineEdit()
        self.search_box.setPlaceholderText("輸入地址或地標，例如：台北101、東京車站、Eiffel Tower")
        # **只綁 returnPressed 與按鈕，不綁 textChanged。**
        # Nominatim 政策明文禁止 auto-complete，打字即查會被封鎖，
        # 跟 debounce 拉多長無關（見 geocode.py 開頭）。
        self.search_box.returnPressed.connect(self._do_search)
        self.search_button = QPushButton("搜尋")
        self.search_button.clicked.connect(self._do_search)

        self.results = QListWidget()
        self.results.setMaximumHeight(110)
        self.results.itemClicked.connect(self._pick_result)
        self.results.hide()

        self.attribution = QLabel(geocode.ATTRIBUTION)
        self.attribution.setStyleSheet("color: #888; font-size: 11px;")

        self.search_signals = SearchSignals()
        self.search_signals.done.connect(self._show_results)
        self.search_signals.failed.connect(lambda m: self._search_failed(m))
        self.places = []

        self.lat = QLineEdit(DEFAULT_LAT)
        self.lng = QLineEdit(DEFAULT_LNG)
        # 貼上「25.033964, 121.564468」整串時自動拆進兩欄 ——
        # Google Maps 右鍵複製出來就是這個格式。
        #
        # 用 editingFinished 而不是 textChanged：後者會在打字打到一半就拆。
        # 手動輸入「25.033964, 1」的當下 parse 就成功了，欄位會被就地改寫成
        # lat=25.033964 / lng=1，游標留在緯度欄，接著打的字全接到緯度後面。
        # 貼上之後直接按開始鈕的情況由 start() 再叫一次補上。
        self.lat.editingFinished.connect(self._maybe_split)

        self.with_maps = QCheckBox("同時開 Google Maps 驗證（會多花約 20 秒）")
        self.with_maps.setChecked(True)

        # ---- 路線 ----
        self.route_file = QPushButton("載入路線檔…")
        self.route_file.clicked.connect(self._load_route)
        self.route_clear = QPushButton("清除")
        self.route_clear.clicked.connect(self._clear_route)
        self.route_clear.setEnabled(False)
        self.route_label = QLabel("未載入路線 —— 只模擬上面那個固定座標")
        self.route_label.setWordWrap(True)

        self.speed = QDoubleSpinBox()
        self.speed.setRange(0.1, 1000.0)
        self.speed.setValue(50.0)
        self.speed.setSuffix(" km/h")
        self.interval = QDoubleSpinBox()
        self.interval.setRange(0.1, 60.0)
        self.interval.setValue(1.0)
        self.interval.setSuffix(" 秒/筆")
        self.loop = QCheckBox("繞圈")
        self.speed.valueChanged.connect(self._refresh_route_label_if_loaded)
        self.interval.valueChanged.connect(self._refresh_route_label_if_loaded)

        self.pause_button = QPushButton("暫停")
        self.pause_button.clicked.connect(self._toggle_pause)
        self.pause_button.setEnabled(False)

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

        search_row = QHBoxLayout()
        search_row.addWidget(self.search_box)
        search_row.addWidget(self.search_button)

        grid = QGridLayout()
        grid.addWidget(QLabel("緯度 Latitude"), 0, 0)
        grid.addWidget(self.lat, 0, 1)
        grid.addWidget(QLabel("經度 Longitude"), 1, 0)
        grid.addWidget(self.lng, 1, 1)

        buttons = QHBoxLayout()
        buttons.addWidget(self.start_button)
        buttons.addWidget(self.stop_button)
        buttons.addStretch()

        route_top = QHBoxLayout()
        route_top.addWidget(self.route_file)
        route_top.addWidget(self.route_clear)
        route_top.addStretch()
        route_options = QHBoxLayout()
        route_options.addWidget(QLabel("速度"))
        route_options.addWidget(self.speed)
        route_options.addWidget(QLabel("更新"))
        route_options.addWidget(self.interval)
        route_options.addWidget(self.loop)
        route_options.addStretch()
        route_box = QVBoxLayout()
        route_box.addLayout(route_top)
        route_box.addWidget(self.route_label)
        route_box.addLayout(route_options)
        route_group = QGroupBox("路線（選用）")
        route_group.setLayout(route_box)

        buttons.insertWidget(2, self.pause_button)

        layout = QVBoxLayout()
        layout.addLayout(search_row)
        layout.addWidget(self.results)
        layout.addWidget(self.attribution)
        layout.addLayout(grid)
        layout.addWidget(self.with_maps)
        layout.addWidget(route_group)
        layout.addLayout(buttons)
        layout.addWidget(self.status)
        layout.addWidget(self.output, stretch=1)

        central = QWidget()
        central.setLayout(layout)
        self.setCentralWidget(central)
        self.resize(680, 780)

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

    # ---- 地址搜尋 ------------------------------------------------------

    def _do_search(self):
        query = self.search_box.text().strip()
        if not query:
            return
        self.search_button.setEnabled(False)
        self._set_status(f"查詢「{query}」…")
        threading.Thread(target=self._search_worker, args=(query,), daemon=True).start()

    def _search_worker(self, query):
        try:
            self.search_signals.done.emit(geocode.search(query))
        except geocode.GeocodeError as e:
            self.search_signals.failed.emit(str(e))

    def _show_results(self, places):
        self.search_button.setEnabled(True)
        self.places = places
        self.results.clear()
        if not places:
            self.results.hide()
            self._set_status("查不到這個地點，換個關鍵字試試", error=True)
            return
        for place in places:
            self.results.addItem(place.short(70))
        self.results.show()
        self._set_status(f"找到 {len(places)} 個，點一下就填進下面的座標")
        # 只有一個結果就直接填，省一次點擊
        if len(places) == 1:
            self._apply_place(places[0])

    def _search_failed(self, message):
        self.search_button.setEnabled(True)
        self.results.hide()
        self._set_status(message, error=True)

    def _pick_result(self, item):
        self._apply_place(self.places[self.results.row(item)])

    def _apply_place(self, place):
        self.lat.setText(f"{place.lat:.6f}")
        self.lng.setText(f"{place.lng:.6f}")
        self._set_status(f"已填入：{place.short(50)}")

    # ---- 路線 ----------------------------------------------------------

    def _load_route(self):
        patterns = " ".join(f"*{ext}" for ext in formats.SUPPORTED.split())
        path, _ = QFileDialog.getOpenFileName(self, "選路線檔", "", f"路線檔 ({patterns})")
        if path:
            self.load_route_file(path)

    def load_route_file(self, path):
        """讀檔並更新標籤。抽出來是為了讓冒煙測試不必去點檔案對話框。"""
        try:
            self.waypoints = formats.load_waypoints(path)
        except RouteFileError as e:
            self._set_status(str(e), error=True)
            return False
        self.route_path = path
        self.route_clear.setEnabled(True)
        self._refresh_route_label()
        return True

    def _refresh_route_label_if_loaded(self):
        if self.waypoints:
            self._refresh_route_label()

    def _clear_route(self):
        self.waypoints = None
        self.route_path = None
        self.route_clear.setEnabled(False)
        self.route_label.setText("未載入路線 —— 只模擬上面那個固定座標")

    def _refresh_route_label(self):
        """把載入的點配上目前的速度／間隔算一次，讓使用者按之前就看得到長度與時間。"""
        try:
            route = self._make_route()
        except RouteError as e:
            self.route_label.setText(str(e))
            return
        self.route_label.setText(
            f"{os.path.basename(self.route_path)}：{len(route.waypoints)} 點，"
            f"{route.total_distance:.0f} m，跑完約 {route.duration:.0f} 秒")

    def _make_route(self):
        return Route(self.waypoints, speed_mps=self.speed.value() / 3.6,
                     interval_s=self.interval.value(), loop=self.loop.isChecked())

    def _toggle_pause(self):
        worker = self.worker
        if not worker or not worker.player:
            return
        if worker.player.state == "running":
            worker.player.pause()
            self.pause_button.setText("繼續")
        else:
            worker.player.resume()
            self.pause_button.setText("暫停")

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

        route = None
        if self.waypoints:
            try:
                route = self._make_route()
            except RouteError as e:
                self._set_status(str(e), error=True)
                self._on_stopped()
                return
            # 路線一定從起點出發，不然開場會從輸入框那個座標跳過去
            lat, lng, _ = route.at(0)
            self.pause_button.setEnabled(True)
            self.pause_button.setText("暫停")

        self.worker = SimulationWorker(lat, lng, self.with_maps.isChecked(), route)
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
        self.pause_button.setEnabled(False)
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
