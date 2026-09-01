"""驗證：模擬到底有沒有生效。

計畫 §6 的核心要求——按下 Start 之後程式印 SUCCESS **不算數**，
必須實際去讀 `navigator.geolocation` 回了什麼。

判定一律用距離不用字串比對（§7）。
"""

import json
import os
import re
import time
from dataclasses import dataclass, field

from .coords import haversine

#: 測試頁的門檻。CDP 的覆寫是精確值，正常應該是 0.00 m。
TEST_PAGE_THRESHOLD_M = 10
#: Google Maps 的門檻放寬——URL 帶的是地圖中心，不是藍點本身。
MAPS_THRESHOLD_M = 200

MAPS_URL = "https://www.google.com/maps"
MAPS_ORIGIN = "https://www.google.com"

#: check 的名稱。report.py 是拿這幾個字串去查表對應到報告的欄位，
#: 改字面值就會讓那邊靜默變成「—」。
CHECK_TEST_PAGE = "navigator.geolocation returns simulated location"
CHECK_MAPS_RECEIVED = "Google Maps receives simulated location"
CHECK_MAPS_LOCATED = "Google Maps Your Location is near target"

#: Maps 的定位鈕沒有穩定的 id，只能靠無障礙標籤找。改版會斷，
#: 斷掉時回報 UNVERIFIED 而不是 FAIL —— 「找不到按鈕」不等於「模擬失敗」。
_LOCATE_BUTTON = r"""(() => {
  const els = [...document.querySelectorAll('button,[role=button]')];
  const hit = els.filter(e => /your location|my location|位置|定位/i.test(
    (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '')));
  return JSON.stringify(hit.map(e => {
    const r = e.getBoundingClientRect();
    return { label: e.getAttribute('aria-label') || e.getAttribute('title'),
             x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  }).filter(c => c.w > 0 && c.h > 0));
})()"""

#: 只觀察頁面拿到什麼，不動它的 DOM 也不攔它的 API（計畫 §8）。
_PROBE = """(() => new Promise(resolve => {
  navigator.geolocation.getCurrentPosition(
    p => resolve({ ok: true, lat: p.coords.latitude, lng: p.coords.longitude,
                   accuracy: p.coords.accuracy }),
    e => resolve({ ok: false, code: e.code, message: e.message }),
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
}))()"""


@dataclass
class Check:
    """一項驗證的結果。

    `status` 有五種，分得開很重要（計畫 §10）：
    PASS / FAIL / PERMISSION_DENIED / UNVERIFIED（測不到，不是失敗）/ SKIPPED。
    """
    name: str
    status: str
    target: tuple | None = None
    actual: tuple | None = None
    distance_m: float | None = None
    detail: str = ""
    artifacts: list = field(default_factory=list)

    @property
    def passed(self):
        return self.status == "PASS"


def click_my_location(provider, session):
    """在已開啟的 Google Maps 分頁上按「你的位置」，回傳按鈕標籤；找不到回 None。

    **只讀 DOM 找按鈕座標、送滑鼠事件，不改 Maps 的任何東西**（計畫 §8）。
    路線播放也要用它 —— 沒按過這顆鈕，Maps 根本不會顯示藍點，
    那時候截圖只會拍到 IP 推測的預設視野，什麼都證明不了。
    """
    candidates = json.loads(provider.evaluate(session, _LOCATE_BUTTON) or "[]")
    if not candidates:
        return None
    button = candidates[0]
    provider.click(session, button["x"], button["y"])
    return button["label"]


def map_center(provider, session):
    """從 Maps 的網址讀出目前地圖中心。讀取是觀察，不是計畫 §8 禁止的竄改。"""
    url = provider.evaluate(session, "location.href") or ""
    m = re.search(r"/@(-?\d+\.\d+),(-?\d+\.\d+)", url)
    return (float(m.group(1)), float(m.group(2))) if m else None


def _classify(result, target, threshold, name):
    if result is None:
        return Check(name, "FAIL", target=target, detail="逾時，頁面沒有回報任何結果")
    if not result.get("ok"):
        code = result.get("code")
        if code == 1:
            return Check(name, "PERMISSION_DENIED", target=target,
                         detail=f"Geolocation permission denied：{result.get('message', '')}")
        return Check(name, "FAIL", target=target,
                     detail=f"GeolocationPositionError code={code}：{result.get('message', '')}")

    actual = (result["lat"], result["lng"])
    distance = haversine(target[0], target[1], actual[0], actual[1])
    return Check(name, "PASS" if distance <= threshold else "FAIL",
                 target=target, actual=actual, distance_m=distance)


def _poll(fn, timeout, interval=0.25):
    """輪詢到 fn 回出非 None 為止。回 None 代表逾時。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = fn()
        if value is not None:
            return value
        time.sleep(interval)
    return None


# ---- Milestone 1 -------------------------------------------------------

def verify_test_page(provider, server, target, timeout=20):
    """開自家的 location-test.html，讀 `window.__result`。"""
    session = provider.open(server.url, origin=server.origin)

    def read():
        raw = provider.evaluate(session, "JSON.stringify(window.__result)")
        return json.loads(raw) if raw and raw != "null" else None

    return _classify(_poll(read, timeout), target, TEST_PAGE_THRESHOLD_M, CHECK_TEST_PAGE)


# ---- Milestone 2 -------------------------------------------------------

def verify_google_maps(provider, target, shots_dir=None, load_wait=12, locate_wait=10):
    """開 Google Maps、按定位鈕、確認地圖中心落在指定座標附近。

    **不改 Maps 的任何東西**：只讀 DOM 找按鈕位置、送滑鼠事件、讀 URL。
    讀 URL 是觀察，跟計畫 §8 禁止的「改 URL 假裝 GPS 變了」是相反的兩件事。
    """
    session = provider.open(MAPS_URL, origin=MAPS_ORIGIN)
    time.sleep(load_wait)

    artifacts = []
    if shots_dir:
        os.makedirs(shots_dir, exist_ok=True)
        artifacts.append(provider.screenshot(session, os.path.join(shots_dir, "maps-loaded.png")))

    # 先確認 Maps 這個 origin 拿到的 geolocation 是什麼。
    # 這一項失敗的話後面點不點按鈕都沒意義。
    received = provider.evaluate(session, _PROBE, await_promise=True)
    received_check = _classify(received, target, TEST_PAGE_THRESHOLD_M, CHECK_MAPS_RECEIVED)
    # 綁的是同一個 list 物件，後面再 append 的截圖這裡也看得到，所以只綁一次就好。
    received_check.artifacts = artifacts

    if not received_check.passed:
        return received_check, Check(CHECK_MAPS_LOCATED, "SKIPPED",
                                     detail="頁面沒拿到模擬座標，不必再按定位鈕")

    button = click_my_location(provider, session)
    if not button:
        return received_check, Check(
            CHECK_MAPS_LOCATED, "UNVERIFIED",
            detail="找不到定位鈕（Maps 改版或語系不同），需要手動確認",
            artifacts=artifacts)

    def centered():
        return map_center(provider, session)

    # 載入時的 URL 也帶著 /@（IP 推測的位置），所以要等它「變成」目標附近，
    # 不能一看到 /@ 就收工。
    def near_target():
        center = centered()
        if center and haversine(target[0], target[1], *center) <= MAPS_THRESHOLD_M:
            return center
        return None

    center = _poll(near_target, locate_wait)
    if shots_dir:
        artifacts.append(provider.screenshot(session, os.path.join(shots_dir, "maps-located.png")))

    if center is None:
        return received_check, Check(
            CHECK_MAPS_LOCATED, "UNVERIFIED",
            target=target, actual=centered(),
            detail=f"按了「{button}」但地圖中心沒移到目標附近，請看截圖確認藍點",
            artifacts=artifacts)

    return received_check, Check(
        CHECK_MAPS_LOCATED, "PASS",
        target=target, actual=center,
        distance_m=haversine(target[0], target[1], *center),
        detail=f"已按「{button}」；藍點位置請以截圖為準", artifacts=artifacts)


# ---- 路線（計畫 §14、§15）--------------------------------------------

CHECK_ROUTE = "Route playback follows the path"

#: 收到的點離路線最遠可以差多少。取樣式最近點自帶約 8 m 的上界誤差
#: （`Route.nearest_distance` 每段取 64 點），這裡留到 25 m。
ROUTE_DEVIATION_M = 25
#: 實測速度與設定速度的容許誤差。CDP 推送與頁面 callback 都有排程抖動，
#: 用中位數比對再放 30%，比對平均值穩得多。
ROUTE_SPEED_TOLERANCE = 0.30


def _median(values):
    ordered = sorted(values)
    middle = len(ordered) // 2
    if not ordered:
        return 0.0
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def verify_route(provider, server, route, laps=1, pause_test=True):
    """播放整條路線，確認頁面的 `watchPosition` 真的沿著它移動。

    四件事一起驗，少一件都會讓某種迴歸綠燈通過：

    - **收到的點貼著路線** —— 只驗「有在動」的話，亂跳也算動
    - **實測速度接近設定值** —— 只驗貼著路線的話，走太快或太慢都看不出來
    - **`heading` / `speed` 有值** —— CDP 收這兩個欄位，漏傳就會靜默變 null
    - **暫停期間不再送位置** —— Pause 是 §15 點名的功能

    Chrome 每換一次 override 都會先發一個 `POSITION_UNAVAILABLE`，
    所以軌跡裡必然夾著錯誤。那是它的行為，只計數不判失敗。
    """
    from .player import RoutePlayer   # 延後 import：verify 不該在檔頭就拉進執行緒模組

    session = provider.open(server.route_url, origin=server.origin)
    time.sleep(1.5)   # 等 watchPosition 掛上去，不然頭幾拍會漏收

    def read_track():
        raw = provider.evaluate(session, "JSON.stringify(window.__track)")
        return json.loads(raw) if raw and raw != "null" else []

    player = RoutePlayer(provider, route, laps=laps).start()

    paused_gap = None
    if pause_test and route.duration > 4:
        # 跑到一半按暫停，停住 3 秒，看這段時間有沒有新的位置進來
        time.sleep(route.duration / 2)
        player.pause()
        time.sleep(0.6)                      # 讓最後一拍落地
        before = len([f for f in read_track() if f.get("ok")])
        time.sleep(3.0)
        after = len([f for f in read_track() if f.get("ok")])
        paused_gap = after - before
        player.resume()

    player.join(timeout=route.duration * laps + 60)
    time.sleep(0.8)
    player.stop()

    track = read_track()
    fixes = [f for f in track if f.get("ok")]
    errors = [f for f in track if not f.get("ok")]

    if len(fixes) < 3:
        return Check(CHECK_ROUTE, "FAIL", detail=(
            f"只收到 {len(fixes)} 筆位置（另有 {len(errors)} 筆錯誤），"
            f"路線預期約 {int(route.duration / route.interval_s)} 筆"))

    deviation = max(route.nearest_distance(f["lat"], f["lng"]) for f in fixes)

    speeds = []
    for a, b in zip(fixes, fixes[1:]):
        dt = (b["timestamp"] - a["timestamp"]) / 1000.0
        if dt > 0:
            speeds.append(haversine(a["lat"], a["lng"], b["lat"], b["lng"]) / dt)
    measured = _median(speeds)

    has_heading = any(f.get("heading") is not None for f in fixes)
    has_speed = any(f.get("speed") is not None for f in fixes)

    problems = []
    if deviation > ROUTE_DEVIATION_M:
        problems.append(f"最遠偏離路線 {deviation:.1f} m（上限 {ROUTE_DEVIATION_M} m）")
    if abs(measured - route.speed_mps) > route.speed_mps * ROUTE_SPEED_TOLERANCE:
        problems.append(f"實測速度 {measured:.1f} m/s，設定 {route.speed_mps} m/s")
    if not has_heading:
        problems.append("heading 全是 null —— CDP 收這個欄位，沒傳到")
    if not has_speed:
        problems.append("speed 全是 null —— CDP 收這個欄位，沒傳到")
    if paused_gap:
        problems.append(f"暫停期間還收到 {paused_gap} 筆位置")

    summary = (f"{len(fixes)} 筆位置，最遠偏離 {deviation:.1f} m，"
               f"實測速度 {measured:.1f} m/s（設定 {route.speed_mps}），"
               f"heading/speed 有值，另有 {len(errors)} 筆 Chrome 換 override 時的 "
               f"POSITION_UNAVAILABLE（預期行為）")
    if paused_gap is not None:
        summary += f"，暫停 3 秒期間新增 {paused_gap} 筆"

    return Check(CHECK_ROUTE, "FAIL" if problems else "PASS",
                 distance_m=deviation,
                 detail="；".join(problems) if problems else summary)
