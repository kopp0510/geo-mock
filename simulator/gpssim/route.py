"""路線模型與內插（計畫 §15）。

純運算，不碰瀏覽器也不碰時間 —— 一條路線就是一串 `Fix`，什麼時候送出去是
`player.py` 的事。這樣路線本身可以直接拿來斷言，不必開瀏覽器。

**內插一律走大圓距離**（`coords.destination`），不是「每秒把緯度加一個固定值」。
後者在不同緯度會產生不同的實際速度，正是 §15 點名不要做的事。
"""

from dataclasses import dataclass

import math

from .coords import EARTH_RADIUS_M, bearing, destination, haversine, validate


def _local(lat, lng, lat0, lng0):
    """以 (lat0, lng0) 為原點的局部平面座標，單位公尺（東為 x、北為 y）。"""
    x = math.radians(lng - lng0) * math.cos(math.radians(lat0)) * EARTH_RADIUS_M
    y = math.radians(lat - lat0) * EARTH_RADIUS_M
    return x, y


def _point_to_segment(ax, ay, bx, by):
    """原點到線段 A-B 的距離（線段已經是以查詢點為原點的局部座標）。"""
    dx, dy = bx - ax, by - ay
    length_squared = dx * dx + dy * dy
    if length_squared == 0:
        return math.hypot(ax, ay)
    # 把原點投影到線段上，t 夾在 [0,1] 之外就取端點
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / length_squared))
    return math.hypot(ax + t * dx, ay + t * dy)


class RouteError(ValueError):
    """路線本身有問題（點太少、速度為零之類）。訊息直接給使用者看。"""


@dataclass(frozen=True)
class Fix:
    """一個時間點上該回報的位置。

    `heading` / `speed` 是 CDP `Emulation.setGeolocationOverride` 真的收的欄位
    （Chrome 152 實測），所以頁面的 `coords.heading` / `coords.speed` 拿得到值。
    """
    lat: float
    lng: float
    heading: float
    speed: float
    elapsed: float      # 從出發算起的秒數
    distance: float     # 從出發算起的累計距離（公尺）


class Route:
    """一串路徑點 + 速度 + 更新間隔。"""

    def __init__(self, waypoints, speed_mps=13.9, interval_s=1.0, loop=False, name=""):
        points = [validate(lat, lng) for lat, lng in waypoints]
        if len(points) < 2:
            raise RouteError(f"路線至少要兩個點，只收到 {len(points)} 個")
        if speed_mps <= 0:
            raise RouteError(f"速度必須大於 0，收到 {speed_mps}")
        if interval_s <= 0:
            raise RouteError(f"更新間隔必須大於 0，收到 {interval_s}")

        self.waypoints = points
        self.speed_mps = float(speed_mps)
        self.interval_s = float(interval_s)
        self.loop = loop
        self.name = name

        # 每一段的長度。零長度的段（重複點）留著不影響結果，走過去就是 0 秒。
        self.legs = [
            haversine(a[0], a[1], b[0], b[1])
            for a, b in zip(points, points[1:])
        ]
        self.total_distance = sum(self.legs)
        if self.total_distance == 0:
            raise RouteError("路線總長度是 0 —— 所有點都在同一個位置")

    @property
    def duration(self):
        """跑完一趟要幾秒。"""
        return self.total_distance / self.speed_mps

    def at(self, distance):
        """走了 `distance` 公尺之後在哪裡、朝哪個方向。

        回 `(lat, lng, heading)`。超過總長度時：loop 就繞回去，否則停在終點。
        """
        if self.loop:
            distance %= self.total_distance
        distance = max(0.0, min(distance, self.total_distance))

        remaining = distance
        for index, leg in enumerate(self.legs):
            start, end = self.waypoints[index], self.waypoints[index + 1]
            if leg == 0:
                continue
            if remaining > leg:
                remaining -= leg
                continue
            heading = bearing(start[0], start[1], end[0], end[1])
            lat, lng = destination(start[0], start[1], heading, remaining)
            return lat, lng, heading

        # 走到終點（或路線只剩零長度段）。方位取最後一段有長度的那一段。
        last = next(i for i in range(len(self.legs) - 1, -1, -1) if self.legs[i] > 0)
        start, end = self.waypoints[last], self.waypoints[last + 1]
        return end[0], end[1], bearing(start[0], start[1], end[0], end[1])

    def fixes(self, laps=1):
        """依 `interval_s` 產生整趟的 Fix。

        `loop=True` 時 `laps` 決定產生幾圈；`loop=False` 時一律一趟，
        而且**保證最後一筆剛好落在終點**（不然按間隔切下去多半會差幾公尺，
        使用者看到的是「停在離終點 8 公尺的地方」）。
        """
        total = self.total_distance * (laps if self.loop else 1)
        step = self.speed_mps * self.interval_s

        elapsed = 0.0
        travelled = 0.0
        while travelled < total:
            lat, lng, heading = self.at(travelled)
            yield Fix(lat, lng, heading, self.speed_mps, elapsed, travelled)
            travelled += step
            elapsed += self.interval_s

        lat, lng, heading = self.at(total)
        yield Fix(lat, lng, heading, self.speed_mps, total / self.speed_mps, total)

    def nearest_distance(self, lat, lng):
        """某個座標離這條路線最近有多遠（公尺）。

        給驗證用：收到的軌跡點必須貼著路線走。

        算法是**以查詢點為原點做局部平面投影**，再取點到線段的距離。
        早期版本是沿著每段取 64 個樣本點取最小值，那個誤差是「取樣間距的一半」，
        段長 5 km 就有 39 公尺 —— 路線明明沒偏也會被判成偏掉。
        平面投影在幾十公里內的誤差遠小於 1 公尺，而且是 O(1)。
        """
        best = float("inf")
        for index, leg in enumerate(self.legs):
            start, end = self.waypoints[index], self.waypoints[index + 1]
            if leg == 0:
                best = min(best, haversine(lat, lng, start[0], start[1]))
                continue
            ax, ay = _local(start[0], start[1], lat, lng)
            bx, by = _local(end[0], end[1], lat, lng)
            best = min(best, _point_to_segment(ax, ay, bx, by))
        return best

    def __repr__(self):
        return (f"Route({len(self.waypoints)} 點, {self.total_distance:.0f} m, "
                f"{self.speed_mps} m/s, 每 {self.interval_s} 秒)")
