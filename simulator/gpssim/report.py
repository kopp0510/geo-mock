"""計畫 §22 規定的回報格式。

每完成一個階段就照這個樣子印。重點是**不能只說 Implementation complete**，
一定要帶實際的驗證結果。
"""

_UNKNOWN = "—"


def _status(check):
    if check is None:
        return _UNKNOWN
    if check.distance_m is not None:
        return f"{check.status}  ({check.distance_m:.2f} m)"
    return check.status


def render(environment, provider, support, checks=(), limitations=(), next_step=""):
    """組出 §22 那個區塊。`checks` 是 verify.Check 的串列。"""
    by_name = {c.name: c for c in checks}
    lines = [
        f"Platform:                    {environment.os_name} {environment.os_version} ({environment.arch})",
        f"Browser:                     {environment.browser}",
        f"Location Simulation Method:  {provider.name if provider else _UNKNOWN}",
        f"Supported:                   {'YES' if support else 'NO'}",
        f"Required Permission:         {'Browser.grantPermissions (geolocation) —— 無彈窗' if support else _UNKNOWN}",
        "",
        f"navigator.geolocation:       {_status(by_name.get('navigator.geolocation returns simulated location'))}",
        f"Google Maps (geolocation):   {_status(by_name.get('Google Maps receives simulated location'))}",
        f"Google Maps (Your Location): {_status(by_name.get('Google Maps Your Location is near target'))}",
    ]

    detail_lines = [f"  - {c.name}: {c.detail}" for c in checks if c.detail]
    if detail_lines:
        lines += ["", "Details:"] + detail_lines

    # 同一張截圖會被兩個 check 各記一次（它們共用同一份清單），去重但保留順序
    artifacts = list(dict.fromkeys(a for c in checks for a in c.artifacts))
    if artifacts:
        lines += ["", "Artifacts:"] + [f"  - {a}" for a in artifacts]

    if not support and provider is None:
        lines += ["", "Location simulation is not supported on this environment."]

    lines += ["", "Known Limitations:"]
    lines += [f"  - {item}" for item in (limitations or ["（無）"])]
    lines += ["", f"Next Step: {next_step or '（無）'}"]
    return "\n".join(lines)


def render_survey(environment, survey):
    """把每個 provider 的支援情形列出來——計畫 §17 要的 capability detection。"""
    lines = [
        f"Platform:      {environment.os_name} {environment.os_version} ({environment.arch})",
        f"Architecture:  {environment.arch}",
        f"Browser:       {environment.browser}",
        f"Chrome path:   {environment.chrome_path or _UNKNOWN}",
        "",
        "Providers（依計畫 §4 的優先順序）:",
    ]
    for cls, support in survey:
        mark = "YES" if support else "NO "
        lines.append(f"  [{mark}] {cls.layer:<7} {cls.name}")
        if support.reason:
            lines.append(f"          {support.reason}")
    if not any(support for _, support in survey):
        lines += ["", "Location simulation is not supported on this environment."]
    return "\n".join(lines)
