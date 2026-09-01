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

    return _classify(_poll(read, timeout), target, TEST_PAGE_THRESHOLD_M,
                     "navigator.geolocation returns simulated location")


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
    received_check = _classify(received, target, TEST_PAGE_THRESHOLD_M,
                               "Google Maps receives simulated location")
    if not received_check.passed:
        received_check.artifacts = artifacts
        return received_check, Check("Google Maps Your Location is near target",
                                     "SKIPPED", detail="頁面沒拿到模擬座標，不必再按定位鈕")

    candidates = json.loads(provider.evaluate(session, _LOCATE_BUTTON) or "[]")
    if not candidates:
        received_check.artifacts = artifacts
        return received_check, Check(
            "Google Maps Your Location is near target", "UNVERIFIED",
            detail="找不到定位鈕（Maps 改版或語系不同），需要手動確認",
            artifacts=artifacts)

    button = candidates[0]
    provider.click(session, button["x"], button["y"])

    def centered():
        url = provider.evaluate(session, "location.href") or ""
        m = re.search(r"/@(-?\d+\.\d+),(-?\d+\.\d+)", url)
        return (float(m.group(1)), float(m.group(2))) if m else None

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
    received_check.artifacts = artifacts

    if center is None:
        last = centered()
        return received_check, Check(
            "Google Maps Your Location is near target", "UNVERIFIED",
            target=target, actual=last,
            detail=f"按了「{button['label']}」但地圖中心沒移到目標附近，請看截圖確認藍點",
            artifacts=artifacts)

    distance = haversine(target[0], target[1], *center)
    return received_check, Check(
        "Google Maps Your Location is near target", "PASS",
        target=target, actual=center, distance_m=distance,
        detail=f"已按「{button['label']}」；藍點位置請以截圖為準", artifacts=artifacts)
