"""從檔案讀路徑點：GPX / KML / GeoJSON / 純文字（計畫 §14）。

四種格式都只取座標，不理會時間戳、高度、樣式那些 —— 速度與更新間隔由使用者
在 `Route` 上指定，用檔案裡的時間戳反推速度是另一件事，還沒有人要。

只用標準庫：`xml.etree` 與 `json`。
"""

import json
import os
import xml.etree.ElementTree as ET

from .coords import InvalidCoordinate, validate


class RouteFileError(ValueError):
    """檔案讀不出路徑點。訊息直接給使用者看。"""


def _gpx(text):
    """GPX：優先取 <trkpt>，沒有的話退回 <rtept>，再沒有才用 <wpt>。

    三種都是 `lat` / `lon` 屬性。namespace 各家寫法不一，所以比對 tag 尾巴
    而不是完整的 qualified name。
    """
    root = ET.fromstring(text)
    for wanted in ("trkpt", "rtept", "wpt"):
        points = [
            (element.get("lat"), element.get("lon"))
            for element in root.iter()
            if element.tag.rsplit("}", 1)[-1] == wanted
        ]
        if points:
            return points
    return []


def _kml(text):
    """KML：<coordinates> 裡是「經度,緯度[,高度]」，**經度在前**。

    這是 KML 與其他格式最容易搞錯的地方，順序寫反的話路線會跑到地球另一邊。
    """
    root = ET.fromstring(text)
    points = []
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1] != "coordinates" or not element.text:
            continue
        for chunk in element.text.split():
            parts = chunk.split(",")
            if len(parts) >= 2:
                points.append((parts[1], parts[0]))
    return points


def _geojson(text):
    """GeoJSON：座標一樣是 [經度, 緯度]。取第一條 LineString / MultiLineString。"""
    data = json.loads(text)

    def coordinates(node):
        if not isinstance(node, dict):
            return None
        geometry = node.get("geometry", node)
        kind = geometry.get("type")
        if kind == "LineString":
            return geometry.get("coordinates", [])
        if kind == "MultiLineString":
            return [p for line in geometry.get("coordinates", []) for p in line]
        for child in node.get("features", []):
            found = coordinates(child)
            if found:
                return found
        return None

    return [(p[1], p[0]) for p in (coordinates(data) or []) if len(p) >= 2]


def _plain(text):
    """純文字：一行一個「緯度, 經度」。`#` 開頭與空行忽略。"""
    points = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.replace(",", " ").split()
        if len(parts) >= 2:
            points.append((parts[0], parts[1]))
    return points


_LOADERS = {
    ".gpx": _gpx,
    ".kml": _kml,
    ".geojson": _geojson,
    ".json": _geojson,
    ".txt": _plain,
    ".csv": _plain,
}

SUPPORTED = " ".join(sorted(_LOADERS))


def load_waypoints(path):
    """讀檔案，回一串已驗證過範圍的 (lat, lng)。"""
    extension = os.path.splitext(path)[1].lower()
    loader = _LOADERS.get(extension)
    if not loader:
        raise RouteFileError(f"不認得的副檔名 {extension or '（無）'}，支援：{SUPPORTED}")

    try:
        with open(path, encoding="utf-8") as f:
            raw = loader(f.read())
    except OSError as e:
        raise RouteFileError(f"讀不到 {path}：{e}")
    except (ET.ParseError, json.JSONDecodeError) as e:
        raise RouteFileError(f"{path} 格式壞掉：{e}")

    if not raw:
        raise RouteFileError(f"{path} 裡找不到任何路徑點")

    points = []
    for index, (lat, lng) in enumerate(raw, 1):
        try:
            points.append(validate(lat, lng))
        except InvalidCoordinate as e:
            # 指出第幾個點，不然在一條上千點的軌跡裡沒人找得到
            raise RouteFileError(f"{path} 第 {index} 個點無效：{e}")
    return points


def parse_waypoints(text):
    """把「25.03,121.56; 25.04,121.57」這種一行字串拆成路徑點。

    給 CLI 的 `--waypoints` 用，不想為了兩個點生一個檔案。
    """
    points = []
    for index, chunk in enumerate(text.split(";"), 1):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = chunk.replace(",", " ").split()
        if len(parts) < 2:
            raise RouteFileError(f"第 {index} 段看不懂：{chunk!r}（預期「緯度,經度」）")
        try:
            points.append(validate(parts[0], parts[1]))
        except InvalidCoordinate as e:
            raise RouteFileError(f"第 {index} 段無效：{e}")
    return points
