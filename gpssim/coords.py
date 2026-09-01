"""座標的驗證與距離計算。純函式，不碰瀏覽器也不碰 OS。"""

import math
import re

EARTH_RADIUS_M = 6371000.0

# 「25.033964, 121.564468」——Google Maps 右鍵複製出來的格式。
# 逗號或空白都收，位數不限 —— Google Maps 複製出來的位數很長，截斷會失準。
_PAIR = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$")


class InvalidCoordinate(ValueError):
    """座標超出範圍或格式不對。訊息直接拿去顯示給使用者。"""


def validate(lat, lng):
    """回傳 (lat, lng) 的 float，超範圍就丟 InvalidCoordinate。

    緯度 -90~90、經度 -180~180。這是計畫 §12 的硬要求：`100, 121.564468` 必須被擋下。
    """
    try:
        lat = float(lat)
        lng = float(lng)
    except (TypeError, ValueError):
        raise InvalidCoordinate(f"座標不是數字：lat={lat!r} lng={lng!r}")

    if not math.isfinite(lat) or not math.isfinite(lng):
        raise InvalidCoordinate("座標必須是有限的數字")
    if abs(lat) > 90:
        raise InvalidCoordinate(f"緯度必須在 -90 ~ +90 之間，收到 {lat}")
    if abs(lng) > 180:
        raise InvalidCoordinate(f"經度必須在 -180 ~ +180 之間，收到 {lng}")
    return lat, lng


def parse_pair(text):
    """把「緯度, 經度」整串拆成 (lat, lng)，順便驗範圍。"""
    m = _PAIR.match(text or "")
    if not m:
        raise InvalidCoordinate(f"看不懂的座標字串：{text!r}（預期「25.033964, 121.564468」）")
    return validate(m.group(1), m.group(2))


def haversine(lat1, lng1, lat2, lng2):
    """兩點間的大圓距離，單位公尺。

    驗收一律比距離不比字串（計畫 §7）：浮點數的尾數差一位不該算失敗。
    """
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2
    )
    return EARTH_RADIUS_M * 2 * math.asin(math.sqrt(a))


def bearing(lat1, lng1, lat2, lng2):
    """從點 1 看向點 2 的初始方位角，0~360 度，正北為 0。

    大圓航線的方位角沿途會變，所以這是「初始」方位 —— 路線模擬每一段都重算。
    """
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlng = math.radians(lng2 - lng1)
    y = math.sin(dlng) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlng)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def destination(lat, lng, bearing_deg, distance_m):
    """從一點沿指定方位走指定距離之後的座標。

    **路線內插一定要用這個，不可以「每秒把緯度加一個固定值」**（計畫 §15）：
    同樣的經度差，在赤道是 111 km、在台北只有 101 km、在極區趨近 0，
    直接加減會讓實際速度隨緯度飄掉。
    """
    angular = distance_m / EARTH_RADIUS_M
    phi1, lambda1 = math.radians(lat), math.radians(lng)
    theta = math.radians(bearing_deg)

    phi2 = math.asin(math.sin(phi1) * math.cos(angular)
                     + math.cos(phi1) * math.sin(angular) * math.cos(theta))
    lambda2 = lambda1 + math.atan2(
        math.sin(theta) * math.sin(angular) * math.cos(phi1),
        math.cos(angular) - math.sin(phi1) * math.sin(phi2))
    # 經度繞回 -180~180，跨換日線時才不會變成 190 這種值
    return math.degrees(phi2), (math.degrees(lambda2) + 540) % 360 - 180
