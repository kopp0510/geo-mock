"""CLI 入口。

第一版刻意只有 CLI，沒有 GUI——計畫 §21：先證明能控制 Geolocation，再做介面。

    uv run python -m gpssim.cli detect
    uv run python -m gpssim.cli test --lat 25.033964 --lng 121.564468
    uv run python -m gpssim.cli maps --lat 25.033964 --lng 121.564468
    uv run python -m gpssim.cli start --coords "25.033964, 121.564468"
"""

import argparse
import os
import sys
import time

from . import detect, formats, geocode, providers, report, verify
from .chrome import ChromeLaunchError
from .coords import InvalidCoordinate, haversine, parse_pair, validate
from .formats import RouteFileError
from .providers.chrome_cdp import ChromeCdpProvider
from .route import Route, RouteError
from .server import TestPageServer

# gpssim/cli.py -> gpssim -> repo 根目錄（simulator/ 那一層拿掉之後少一層）
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS_DIR = os.path.join(REPO_ROOT, ".screenshots")

LIMITATIONS = [
    "只支援 Chrome。Edge / Firefox / Safari 尚未評估（計畫 §16）",
    "必須自己啟動一個獨立 profile 的 Chrome（Chrome 136 起的限制），"
    "那個瀏覽器沒有登入 Google",
    "OS 層級的定位注入在所有平台都尚未支援，只有瀏覽器層",
    "Google Maps 的定位鈕沒有穩定 selector，改版會讓最後一項變成 UNVERIFIED",
    "路線播放時，Chrome 每換一次 override 都會先對 watchPosition 發一個 "
    "POSITION_UNAVAILABLE 再發新位置 —— 那是 Chrome 的行為，擋不掉",
]


def _target(args):
    if args.coords:
        return parse_pair(args.coords)
    if args.lat is None or args.lng is None:
        raise InvalidCoordinate("請給 --lat 與 --lng，或用 --coords \"緯度, 經度\"")
    return validate(args.lat, args.lng)


def cmd_gui(_args):
    # 延後 import：沒裝 PySide6 的人跑其他子指令不該被擋下來。
    try:
        from .gui import main as gui_main
    except ImportError:
        print("沒有 PySide6。跑 `uv sync --extra gui` 裝好再試。", file=sys.stderr)
        return 2
    return gui_main()


def cmd_search(args):
    """查地址，印出候選座標。**只查一次，不做打字即查**（Nominatim 政策）。"""
    try:
        places = geocode.search(args.query)
    except geocode.GeocodeError as e:
        print(f"查詢失敗：{e}", file=sys.stderr)
        return 2
    if not places:
        print("查不到這個地點")
        return 1
    for index, place in enumerate(places, 1):
        print(f"{index}. {place.lat:.6f}, {place.lng:.6f}  {place.label}")
    print(f"\n{geocode.ATTRIBUTION}")
    return 0


def cmd_detect(_args):
    environment = detect.detect()
    print(report.render_survey(environment, providers.survey()))
    return 0


def _run(target, with_maps, keep_open):
    lat, lng = target
    environment = detect.detect()
    provider = ChromeCdpProvider()
    support = provider.is_supported()

    if not support:
        print(report.render(environment, None, support,
                            limitations=[support.reason],
                            next_step="安裝 Google Chrome 或設定 CHROME_BIN"))
        return 2

    checks = []
    # start() 一定要在 try 裡面：Chrome 起來了但 CDP 接不上時，
    # 若寫在外面 stop() 就不會被呼叫，那個 Chrome 與 temp profile 會留在系統上。
    # stop() 對「只起了一半」的 provider 是安全的。
    try:
        provider.start(lat, lng)
        with TestPageServer() as server:
            checks.append(verify.verify_test_page(provider, server, (lat, lng)))

        if with_maps and checks[0].passed:
            checks.extend(verify.verify_google_maps(provider, (lat, lng), shots_dir=SHOTS_DIR))
        elif with_maps:
            print("測試頁那一關沒過，跳過 Google Maps。", file=sys.stderr)

        if keep_open:
            print("\nChrome 保持開啟中。按 Enter 停止模擬並關閉……")
            try:
                input()
            except EOFError:
                pass   # 非互動環境（管線、CI）沒有 stdin，直接收工就好
    finally:
        # 計畫 §13：無論成敗都要還原，不能讓環境一直停在假位置。
        provider.stop()

    return _finish(environment, provider, support, checks)


def _report_maps_route(route, start, end, shots):
    """路線模式下的 Google Maps 觀察 —— **只印資訊，不進判定**。

    為什麼不做成 PASS/FAIL：實測 Google Maps 在這條路徑上量不出東西。

    1. **藍點不會即時跟著跑**。路線走完 1152 m，測試頁的 `watchPosition`
       一路收到新座標，Maps 的藍點卻停在按下定位鈕當下的位置 ——
       前後兩張截圖的藍點在同一個像素上。
    2. **同分頁重按定位鈕也不動**，Maps 把位置快取住了。
    3. **另開全新分頁**才會拿到比較新的位置，但仍是快取的中途位置
       （實測落在路線 700 m 處，而 provider 當下的位置是 1152 m 的終點，差 0.0 m）。

    做成 UNVERIFIED 的話 `route --maps` 會永遠 exit 3，久了就沒人看 exit code 了。
    路線到底有沒有動，`Route playback follows the path` 那一項量得準得多。
    """
    print("\nGoogle Maps 觀察（僅供參考，不列入判定）：")
    if start and end:
        print(f"  起點視野 {start[0]:.6f},{start[1]:.6f} → 新分頁 {end[0]:.6f},{end[1]:.6f}"
              f"（相距 {haversine(start[0], start[1], end[0], end[1]):.0f} m，"
              f"路線總長 {route.total_distance:.0f} m）")
    print("  Maps 的藍點不會即時跟著模擬移動，也會快取位置 —— "
          "要確認路線真的有動，看上面的 Route playback 那一項與截圖")
    for shot in shots:
        print(f"  截圖 {shot}")


def _build_route(args):
    if args.file:
        waypoints = formats.load_waypoints(args.file)
        name = os.path.basename(args.file)
    elif args.waypoints:
        waypoints = formats.parse_waypoints(args.waypoints)
        name = "命令列指定"
    else:
        raise RouteFileError("請給 --file 或 --waypoints")

    speed = args.speed if args.speed else (args.kmh / 3.6 if args.kmh else 13.9)
    return Route(waypoints, speed_mps=speed, interval_s=args.interval,
                 loop=args.loop, name=name)


def cmd_route(args):
    """播放一條路線並驗證頁面真的沿著它移動（計畫 §14、§15）。"""
    route = _build_route(args)
    environment = detect.detect()
    provider = ChromeCdpProvider()
    support = provider.is_supported()
    if not support:
        print(report.render(environment, None, support, limitations=[support.reason],
                            next_step="安裝 Google Chrome 或設定 CHROME_BIN"))
        return 2

    laps = args.laps if route.loop else 1
    print(f"{route}  總長 {route.total_distance:.0f} m，"
          f"單趟 {route.duration:.0f} 秒 × {laps} 趟")

    checks = []
    try:
        # 從起點開始，不然開場那一下會從預設座標跳過去
        start_lat, start_lng, _ = route.at(0)
        provider.start(start_lat, start_lng)

        maps_session = maps_start = None
        if args.maps:
            # **一定要先按下定位鈕**，Maps 不會自己顯示藍點；沒按就截圖只會拍到
            # IP 推測的預設視野，證明不了任何事。踩過一次。
            maps_session = provider.open(verify.MAPS_URL, origin=verify.MAPS_ORIGIN)
            time.sleep(12)
            os.makedirs(SHOTS_DIR, exist_ok=True)
            label = verify.click_my_location(provider, maps_session)
            time.sleep(6)
            maps_start = verify.map_center(provider, maps_session)
            provider.screenshot(maps_session, os.path.join(SHOTS_DIR, "route-maps-start.png"))
            print(f"Google Maps：已按「{label}」，起點視野 {maps_start}")

        with TestPageServer() as server:
            checks.append(verify.verify_route(provider, server, route, laps=laps))

        if args.maps:
            # **開一個全新的分頁**，不是重按原分頁的定位鈕。
            # 實測：原分頁按第二次照樣停在原位，Maps 把位置快取住了。
            # 全新頁面一定得重新問一次 geolocation，這才問得出「來源現在是什麼」。
            fresh = provider.open(verify.MAPS_URL, origin=verify.MAPS_ORIGIN)
            time.sleep(12)
            verify.click_my_location(provider, fresh)
            time.sleep(6)
            maps_end = verify.map_center(provider, fresh)
            shot = os.path.join(SHOTS_DIR, "route-maps-end.png")
            provider.screenshot(fresh, shot)
            maps_shots = [os.path.join(SHOTS_DIR, "route-maps-start.png"), shot]
            checks[-1].artifacts.extend(maps_shots)
            _report_maps_route(route, maps_start, maps_end, maps_shots)

        if args.keep_open:
            print("\nChrome 保持開啟中。按 Enter 停止模擬並關閉……")
            try:
                input()
            except EOFError:
                pass
    finally:
        provider.stop()

    return _finish(environment, provider, support, checks)


def _finish(environment, provider, support, checks):
    """印報告並決定 exit code。

    「測不到」與「失敗」要用不同的 code 分開。併進 0 會讓沒驗到的那一輪
    看起來像全過（Maps 改版就是這條路徑）；併進 1 又會讓「Maps 換版面」
    看起來像「模擬壞了」。
    """
    failed = [c for c in checks if c.status in ("FAIL", "PERMISSION_DENIED")]
    unverified = [c for c in checks if c.status == "UNVERIFIED"]

    if failed:
        code, next_step = 1, "先修掉上面失敗的項目"
    elif unverified:
        code, next_step = 3, "看 .screenshots/ 的截圖人工確認藍點，再決定是不是真的有問題"
    else:
        code, next_step = 0, "（無）"

    print(report.render(environment, provider, support, checks, LIMITATIONS,
                        next_step=next_step))
    return code


def cmd_test(args):
    return _run(_target(args), with_maps=False, keep_open=args.keep_open)


def cmd_maps(args):
    return _run(_target(args), with_maps=True, keep_open=args.keep_open)


def cmd_start(args):
    return _run(_target(args), with_maps=args.maps, keep_open=True)


def _add_coords(parser):
    parser.add_argument("--lat", type=float, help="緯度 -90 ~ +90")
    parser.add_argument("--lng", type=float, help="經度 -180 ~ +180")
    parser.add_argument("--coords", help='「緯度, 經度」整串，例如 "25.033964, 121.564468"')
    parser.add_argument("--keep-open", action="store_true",
                        help="驗證完保持 Chrome 開著，按 Enter 才收")


def build_parser():
    parser = argparse.ArgumentParser(
        prog="gpssim", description="跨平台 GPS / Location Simulator")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("detect", help="印出環境與各 provider 的支援情形").set_defaults(func=cmd_detect)
    sub.add_parser("gui", help="開圖形介面（需要 uv sync --extra gui）").set_defaults(func=cmd_gui)

    p_search = sub.add_parser("search", help="用地址或地標查座標")
    p_search.add_argument("query", help='例如「台北101」')
    p_search.set_defaults(func=cmd_search)

    p_test = sub.add_parser("test", help="Milestone 1：驗 navigator.geolocation")
    _add_coords(p_test)
    p_test.set_defaults(func=cmd_test)

    p_maps = sub.add_parser("maps", help="Milestone 2：連 Google Maps 一起驗")
    _add_coords(p_maps)
    p_maps.set_defaults(func=cmd_maps)

    p_route = sub.add_parser("route", help="播放一條路線（計畫 §14、§15）")
    p_route.add_argument("--file", help=f"路線檔。支援 {formats.SUPPORTED}")
    p_route.add_argument("--waypoints", help='直接給點：「25.03,121.56; 25.04,121.57」')
    p_route.add_argument("--speed", type=float, help="速度 m/s（預設 13.9，約 50 km/h）")
    p_route.add_argument("--kmh", type=float, help="速度 km/h（與 --speed 擇一）")
    p_route.add_argument("--interval", type=float, default=1.0, help="更新間隔秒數")
    p_route.add_argument("--loop", action="store_true", help="繞圈")
    p_route.add_argument("--laps", type=int, default=1, help="繞幾圈（需搭配 --loop）")
    p_route.add_argument("--maps", action="store_true", help="同時開 Google Maps 看藍點跑")
    p_route.add_argument("--keep-open", action="store_true", help="跑完保持 Chrome 開著")
    p_route.set_defaults(func=cmd_route)

    p_start = sub.add_parser("start", help="開始模擬並保持瀏覽器開著")
    _add_coords(p_start)
    p_start.add_argument("--maps", action="store_true", help="順便開 Google Maps 驗一次")
    p_start.set_defaults(func=cmd_start)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except InvalidCoordinate as e:
        print(f"座標無效：{e}", file=sys.stderr)
        return 2
    except (RouteFileError, RouteError) as e:
        print(f"路線有問題：{e}", file=sys.stderr)
        return 2
    except ChromeLaunchError as e:
        print(f"啟動 Chrome 失敗：{e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
