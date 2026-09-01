"""Location provider 們。優先順序即計畫 §4 的順序。"""

from .base import LocationProvider, Support
from .chrome_cdp import ChromeCdpProvider
from .extension import ExtensionProvider
from .os_native import OsNativeProvider

# 由高到低。`pick()` 走第一個說自己支援的。
ORDER = [OsNativeProvider, ChromeCdpProvider, ExtensionProvider]

__all__ = [
    "LocationProvider", "Support", "ChromeCdpProvider",
    "ExtensionProvider", "OsNativeProvider", "ORDER", "pick", "survey",
]


def survey():
    """每個 provider 的支援情形，依優先順序。"""
    return [(cls, cls().is_supported()) for cls in ORDER]


def pick():
    """挑出可用的 provider；全都不支援回 None（計畫 §4 第三優先）。"""
    for cls, support in survey():
        if support:
            return cls()
    return None
