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

from . import detect, providers, report, verify
from .chrome import ChromeLaunchError
from .coords import InvalidCoordinate, parse_pair, validate
from .providers.chrome_cdp import ChromeCdpProvider
from .server import TestPageServer

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS_DIR = os.path.join(REPO_ROOT, ".screenshots")

LIMITATIONS = [
    "只支援 Chrome。Edge / Firefox / Safari 尚未評估（計畫 §16）",
    "必須自己啟動一個獨立 profile 的 Chrome（Chrome 136 起的限制），"
    "那個瀏覽器沒有登入 Google",
    "OS 層級的定位注入在所有平台都尚未支援，只有瀏覽器層",
    "Google Maps 的定位鈕沒有穩定 selector，改版會讓最後一項變成 UNVERIFIED",
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

    failed = [c for c in checks if c.status in ("FAIL", "PERMISSION_DENIED")]
    unverified = [c for c in checks if c.status == "UNVERIFIED"]

    # 「測不到」與「失敗」要用不同的 exit code 分開。併進 0 會讓沒驗到的那一輪
    # 看起來像全過（Maps 改版就是這條路徑）；併進 1 又會讓「Maps 換版面」
    # 看起來像「模擬壞了」。
    if failed:
        code, next_step = 1, "先修掉上面失敗的項目"
    elif unverified:
        code, next_step = 3, "看 .screenshots/ 的截圖人工確認藍點，再決定是不是真的有問題"
    else:
        code, next_step = 0, "接 PySide6 GUI（計畫 §19 第三階段）"

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

    p_test = sub.add_parser("test", help="Milestone 1：驗 navigator.geolocation")
    _add_coords(p_test)
    p_test.set_defaults(func=cmd_test)

    p_maps = sub.add_parser("maps", help="Milestone 2：連 Google Maps 一起驗")
    _add_coords(p_maps)
    p_maps.set_defaults(func=cmd_maps)

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
    except ChromeLaunchError as e:
        print(f"啟動 Chrome 失敗：{e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
