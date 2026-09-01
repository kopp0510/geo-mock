"""地址搜尋 —— 包住 Nominatim 的查詢、快取與速率閘門。

沒人記得住經緯度，所以介面要能打「台北101」。

── Nominatim 使用政策（硬約束，違反會被封鎖）───────────────────────────
https://operations.osmfoundation.org/policies/nominatim/
**這支檔案是唯一送出請求的地方**，政策的每一條都兌現在這裡：

Requirements
  · 絕對上限每秒 1 次        → `_gate()`，時間戳同時看記憶體與磁碟快取
  · 必須提供可識別應用程式的 User-Agent，政策原文明寫
    「stock User-Agents as set by http libraries will not do」
                             → `USER_AGENT`。Python 這邊可以直接設 header，
                               （瀏覽器裡的 fetch 設不了這個 header，Python 可以）
  · 必須顯示出處              → `ATTRIBUTION`，介面上要印出來

Unacceptable Use（政策原文：strictly forbidden and will get you banned）
  · Auto-complete search：「you must not implement such a service on the
    client side using the API」→ **搜尋只由 Enter 或搜尋鈕觸發，不做打字即查**。
    這條跟速率無關，debounce 拉多長都不合規，別加回來
  · 重複送同一個 query 會被歸類為 faulty client → 快取 + 同字串去重

自動化測試也**不要**拿真的查詢去跑迴圈 —— 那正是政策禁止的行為。
冒煙測試要用已經在快取裡的字串。
"""

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

ENDPOINT = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "gpssim/0.1 (geo-mock GPS Simulator; local development tool)"
ATTRIBUTION = "地址資料來源：OpenStreetMap contributors（Nominatim）"

MIN_INTERVAL_S = 1.0                    # 兩次實際送出之間的硬下限
TIMEOUT_S = 8
CACHE_TTL_S = 7 * 24 * 60 * 60
CACHE_MAX = 50                          # 快取筆數上限，超過丟最舊的
LIMIT = 5                               # 候選清單長度

CACHE_PATH = os.path.join(
    os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"),
    "gpssim", "geocode.json")

_lock = threading.Lock()


class GeocodeError(RuntimeError):
    """查詢失敗。訊息直接給使用者看。"""


@dataclass(frozen=True)
class Place:
    label: str
    lat: float
    lng: float

    def short(self, width=60):
        return self.label if len(self.label) <= width else self.label[:width - 1] + "…"


# ---- 快取 --------------------------------------------------------------

def _load_cache():
    try:
        with open(CACHE_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"entries": {}, "last_at": 0}
    data.setdefault("entries", {})
    data.setdefault("last_at", 0)
    return data


def _save_cache(data):
    try:
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
        with open(CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except OSError:
        pass    # 寫不進去不該讓查詢失敗，最多就是下次重查


def _key(query, lang):
    """語系進 key —— 同一個查詢在 zh-TW 與 en 回不同的地名。"""
    return f"{lang}|{' '.join(query.split()).lower()}"


def _prune(entries):
    if len(entries) <= CACHE_MAX:
        return entries
    oldest = sorted(entries.items(), key=lambda kv: kv[1].get("at", 0))
    for key, _ in oldest[:len(entries) - CACHE_MAX]:
        entries.pop(key, None)
    return entries


# ---- 查詢 --------------------------------------------------------------

def _gate(cache):
    """把「每秒至多 1 次」兌現掉。

    時間戳**在送出之前**就寫回磁碟：寫失敗就直接放棄這次查詢，
    不會出現「送了但沒記錄」而讓下一次立刻又送。
    """
    wait = MIN_INTERVAL_S - (time.time() - cache.get("last_at", 0))
    if wait > 0:
        time.sleep(wait)
    cache["last_at"] = time.time()
    _save_cache(cache)


def _fetch(query, lang):
    params = urllib.parse.urlencode({
        "format": "jsonv2", "limit": LIMIT, "accept-language": lang, "q": query,
    })
    request = urllib.request.Request(f"{ENDPOINT}?{params}",
                                     headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            raw = json.load(response)
    except urllib.error.HTTPError as e:
        raise GeocodeError(f"Nominatim 回 HTTP {e.code}（可能是被限流了，等一下再試）")
    except urllib.error.URLError as e:
        raise GeocodeError(f"連不上 Nominatim：{e.reason}")
    except TimeoutError:
        raise GeocodeError(f"查詢超過 {TIMEOUT_S} 秒沒回應")
    except json.JSONDecodeError:
        # 回的不是 JSON 多半是被中間的登入頁攔截（公司網路、飯店 Wi-Fi）
        raise GeocodeError("Nominatim 回的不是 JSON，檢查網路是不是被攔截")

    if not isinstance(raw, list):
        raise GeocodeError("Nominatim 回了預期外的格式")

    places = []
    for item in raw:
        try:
            places.append(Place(item["display_name"],
                                float(item["lat"]), float(item["lon"])))
        except (KeyError, TypeError, ValueError):
            continue    # 單筆壞掉就跳過，不要讓整次查詢陪葬
    return places


def search(query, lang="zh-TW"):
    """查地址，回最多 5 個候選。**只能由使用者的明確動作觸發，不可打字即查。**"""
    query = " ".join((query or "").split())
    if not query:
        return []

    key = _key(query, lang)
    with _lock:
        cache = _load_cache()
        entry = cache["entries"].get(key)
        if entry and time.time() - entry.get("at", 0) < CACHE_TTL_S:
            return [Place(*p) for p in entry["places"]]

        _gate(cache)
        places = _fetch(query, lang)

        cache["entries"][key] = {
            "at": time.time(),
            "places": [[p.label, p.lat, p.lng] for p in places],
        }
        cache["entries"] = _prune(cache["entries"])
        _save_cache(cache)
        return places
