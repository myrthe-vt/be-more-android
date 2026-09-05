from __future__ import annotations

import re
from typing import Optional

from core.homelab import (
    containers,
    disk_usage,
    node_online,
    system_status,
)


DISK_WARNING_PERCENT = 85
DISK_CRITICAL_PERCENT = 95

MEMORY_WARNING_PERCENT = 85
MEMORY_CRITICAL_PERCENT = 95

TEMP_WARNING_C = 75.0
TEMP_CRITICAL_C = 85.0


def _parse_percent(value) -> Optional[float]:
    if value is None:
        return None

    match = re.search(
        r"(\d+(?:\.\d+)?)",
        str(value),
    )

    if not match:
        return None

    try:
        return float(match.group(1))
    except ValueError:
        return None


def _size_to_bytes(value: str) -> Optional[float]:
    match = re.fullmatch(
        r"\s*(\d+(?:\.\d+)?)\s*([kmgtpe]?i?b?)?\s*",
        str(value or ""),
        re.IGNORECASE,
    )

    if not match:
        return None

    number = float(match.group(1))
    unit = (match.group(2) or "").lower()

    multipliers = {
        "": 1,
        "b": 1,
        "k": 1000,
        "kb": 1000,
        "ki": 1024,
        "kib": 1024,
        "m": 1000 ** 2,
        "mb": 1000 ** 2,
        "mi": 1024 ** 2,
        "mib": 1024 ** 2,
        "g": 1000 ** 3,
        "gb": 1000 ** 3,
        "gi": 1024 ** 3,
        "gib": 1024 ** 3,
        "t": 1000 ** 4,
        "tb": 1000 ** 4,
        "ti": 1024 ** 4,
        "tib": 1024 ** 4,
        "p": 1000 ** 5,
        "pb": 1000 ** 5,
        "pi": 1024 ** 5,
        "pib": 1024 ** 5,
        "e": 1000 ** 6,
        "eb": 1000 ** 6,
        "ei": 1024 ** 6,
        "eib": 1024 ** 6,
    }

    multiplier = multipliers.get(unit)

    if multiplier is None:
        return None

    return number * multiplier


def _parse_memory_percent(value: str) -> Optional[float]:
    if not value or "/" not in str(value):
        return None

    used_text, total_text = str(value).split("/", 1)

    used = _size_to_bytes(used_text)
    total = _size_to_bytes(total_text)

    if used is None or total in (None, 0):
        return None

    return (used / total) * 100.0


def _issue(
    severity: str,
    category: str,
    node: str,
    message: str,
    evidence: str,
    next_check: str,
    recovery_hint: str,
) -> dict:
    return {
        "severity": severity,
        "category": category,
        "node": node,
        "message": message,
        "evidence": evidence,
        "next_check": next_check,
        "recovery_hint": recovery_hint,
    }


def _check_node_online(
    node_name: str,
    issues: list[dict],
) -> bool:
    result = node_online(node_name)

    if result.get("online"):
        return True

    display_name = result.get("name", node_name)
    error = result.get(
        "error",
        "No response from the node.",
    )

    issues.append(
        _issue(
            "critical",
            "node",
            node_name,
            f"{display_name} is offline or unreachable.",
            f"Reachability check failed: {error}",
            (
                f"Check whether {display_name} is powered on, "
                "connected to the network, and reachable over SSH."
            ),
            (
                f"If the machine is powered on, verify its network connection "
                f"and SSH access first. If it is intentionally asleep or off, "
                f"no repair may be needed."
            ),
        )
    )

    return False


def _check_containers(
    node_name: str,
    issues: list[dict],
):
    result = containers(node_name)

    if not result.get("ok"):
        display_name = result.get("name", node_name)
        error = result.get(
            "error",
            "Docker inspection failed.",
        )

        issues.append(
            _issue(
                "warning",
                "containers",
                node_name,
                f"I couldn't inspect Docker on {display_name}.",
                error,
                (
                    f"Verify BMO can run docker ps on {display_name} "
                    "and that Docker itself is responding."
                ),
                (
                    f"If Docker is running but inspection still fails, "
                    f"check SSH permissions and Docker socket access on {display_name}."
                ),
            )
        )

        return

    display_name = result.get("name", node_name)

    for container in result.get("containers", []):
        name = container.get(
            "name",
            "unknown container",
        )

        status = str(
            container.get(
                "status",
                "",
            )
        )

        normalized = status.lower()

        if "unhealthy" in normalized:
            issues.append(
                _issue(
                    "critical",
                    "container",
                    node_name,
                    f"{name} on {display_name} is unhealthy.",
                    f"Docker reports: {status}",
                    (
                        f"Check the recent logs and configured healthcheck "
                        f"for the {name} container."
                    ),
                    (
                        f"If the logs show a transient startup or dependency problem, "
                        f"a controlled restart of {name} may be reasonable after review. "
                        f"If the healthcheck keeps failing, inspect the underlying service "
                        f"or dependency instead of repeatedly restarting it."
                    ),
                )
            )

        elif (
            "restarting" in normalized
            or "dead" in normalized
        ):
            issues.append(
                _issue(
                    "critical",
                    "container",
                    node_name,
                    f"{name} on {display_name} is {status}.",
                    f"Docker reports: {status}",
                    (
                        f"Check the recent logs for {name} and determine "
                        "why it cannot remain running."
                    ),
                    (
                        f"Do not blindly restart it in a loop. "
                        f"Review the error first, then restart only if the cause "
                        f"looks transient or has already been corrected."
                    ),
                )
            )


def _check_disk(
    node_name: str,
    disk_name: str,
    issues: list[dict],
):
    result = disk_usage(
        node_name,
        disk_name,
    )

    if not result.get("ok"):
        display_name = result.get("name", node_name)
        error = result.get(
            "error",
            "Disk inspection failed.",
        )

        issues.append(
            _issue(
                "warning",
                "disk",
                node_name,
                f"I couldn't check {display_name} storage.",
                error,
                (
                    f"Verify that {result.get('path', disk_name)} "
                    f"is mounted and readable on {display_name}."
                ),
                (
                    f"If the disk is expected to be mounted, check the mount "
                    f"and filesystem state before writing new data to it."
                ),
            )
        )

        return

    percent = _parse_percent(
        result.get("percent_used")
    )

    if percent is None:
        return

    display_name = result.get(
        "name",
        node_name,
    )

    available = result.get(
        "available",
        "an unknown amount",
    )

    used = result.get(
        "used",
        "an unknown amount",
    )

    size = result.get(
        "size",
        "an unknown size",
    )

    path = result.get(
        "path",
        "",
    )

    evidence = (
        f"{path} is {percent:.0f}% used, "
        f"with {used} used out of {size} "
        f"and {available} free."
    )

    next_check = (
        f"Check the largest directories on {display_name} "
        "and identify data that can safely be deleted or moved."
    )

    recovery_hint = (
        f"Free space deliberately rather than deleting random files. "
        f"Start with caches, old downloads, duplicate media, old model files, "
        f"or other known disposable data on {display_name}, then re-run the health check."
    )

    if percent >= DISK_CRITICAL_PERCENT:
        issues.append(
            _issue(
                "critical",
                "disk",
                node_name,
                f"{display_name} storage at {path} is critically full.",
                evidence,
                next_check,
                recovery_hint,
            )
        )

    elif percent >= DISK_WARNING_PERCENT:
        issues.append(
            _issue(
                "warning",
                "disk",
                node_name,
                f"{display_name} storage at {path} is getting full.",
                evidence,
                next_check,
                recovery_hint,
            )
        )


def _check_system_health(
    node_name: str,
    issues: list[dict],
):
    result = system_status(node_name)

    if not result.get("ok"):
        display_name = result.get("name", node_name)
        error = result.get(
            "error",
            "Detailed system status failed.",
        )

        issues.append(
            _issue(
                "warning",
                "system",
                node_name,
                f"I couldn't read detailed system health from {display_name}.",
                error,
                (
                    f"Check SSH access and basic system tools on {display_name}."
                ),
                (
                    f"If the node is otherwise reachable, verify that the "
                    f"commands BMO relies on are available and permitted."
                ),
            )
        )

        return

    display_name = result.get(
        "name",
        node_name,
    )

    memory_text = result.get(
        "memory",
        "",
    )

    memory_percent = _parse_memory_percent(
        memory_text
    )

    if memory_percent is not None:
        evidence = (
            f"Memory usage is {memory_text}, "
            f"about {memory_percent:.0f}%."
        )

        next_check = (
            f"Check which processes or containers on {display_name} "
            "are using the most memory."
        )

        recovery_hint = (
            f"If one process is clearly misbehaving, investigate or restart "
            f"that specific service. Avoid rebooting {display_name} unless "
            f"there is no narrower recovery option."
        )

        if memory_percent >= MEMORY_CRITICAL_PERCENT:
            issues.append(
                _issue(
                    "critical",
                    "memory",
                    node_name,
                    f"{display_name} memory usage is critically high.",
                    evidence,
                    next_check,
                    recovery_hint,
                )
            )

        elif memory_percent >= MEMORY_WARNING_PERCENT:
            issues.append(
                _issue(
                    "warning",
                    "memory",
                    node_name,
                    f"{display_name} memory usage is high.",
                    evidence,
                    next_check,
                    recovery_hint,
                )
            )

    temperature = result.get(
        "temperature_c"
    )

    try:
        temperature = (
            float(temperature)
            if temperature is not None
            else None
        )
    except (TypeError, ValueError):
        temperature = None

    if temperature is not None:
        evidence = (
            f"Reported temperature is "
            f"{temperature:.0f} degrees Celsius."
        )

        next_check = (
            f"Check cooling, airflow, and current load on {display_name}."
        )

        recovery_hint = (
            f"Reduce heavy workload if possible and make sure vents or fans "
            f"are unobstructed. If temperatures stay high at light load, "
            f"inspect cooling before continuing sustained workloads."
        )

        if temperature >= TEMP_CRITICAL_C:
            issues.append(
                _issue(
                    "critical",
                    "temperature",
                    node_name,
                    f"{display_name} is running critically hot.",
                    evidence,
                    next_check,
                    recovery_hint,
                )
            )

        elif temperature >= TEMP_WARNING_C:
            issues.append(
                _issue(
                    "warning",
                    "temperature",
                    node_name,
                    f"{display_name} is running warm.",
                    evidence,
                    next_check,
                    recovery_hint,
                )
            )


def check_homelab_health() -> dict:
    issues = []

    online = {
        "primary": _check_node_online(
            "primary",
            issues,
        ),
        "media": _check_node_online(
            "media",
            issues,
        ),
        "local": _check_node_online(
            "local",
            issues,
        ),
    }

    if online["primary"]:
        _check_containers(
            "primary",
            issues,
        )

        _check_disk(
            "primary",
            "external",
            issues,
        )

        _check_system_health(
            "primary",
            issues,
        )

    if online["media"]:
        _check_containers(
            "media",
            issues,
        )

        _check_disk(
            "media",
            "storage",
            issues,
        )

        _check_system_health(
            "media",
            issues,
        )

    if online["local"]:
        _check_disk(
            "local",
            "system",
            issues,
        )

    critical = [
        item
        for item in issues
        if item["severity"] == "critical"
    ]

    warnings = [
        item
        for item in issues
        if item["severity"] == "warning"
    ]

    return {
        "ok": not critical,
        "healthy": not issues,
        "critical_count": len(critical),
        "warning_count": len(warnings),
        "issues": issues,
        "nodes_online": online,
    }


def describe_homelab_health() -> str:
    result = check_homelab_health()
    issues = result["issues"]

    if not issues:
        return (
            "Everything I checked looks healthy. "
            "Homeserver, Media, and Local are online, "
            "and I didn't find any unhealthy containers, "
            "storage warnings, memory warnings, or temperature problems."
        )

    critical = [
        item
        for item in issues
        if item["severity"] == "critical"
    ]

    warnings = [
        item
        for item in issues
        if item["severity"] == "warning"
    ]

    parts = []

    if critical:
        parts.append(
            f"I found {len(critical)} serious "
            f"{'problem' if len(critical) == 1 else 'problems'}."
        )

    if warnings:
        parts.append(
            f"I also found {len(warnings)} "
            f"{'warning' if len(warnings) == 1 else 'warnings'}."
        )

    for item in critical + warnings:
        parts.append(
            item["message"]
        )

    return " ".join(parts)


def describe_homelab_diagnostics() -> str:
    result = check_homelab_health()
    issues = result["issues"]

    if not issues:
        return (
            "I don't see anything wrong right now. "
            "All three nodes are reachable, and the checks "
            "for containers, storage, memory, and temperature "
            "are within the configured limits."
        )

    ordered = sorted(
        issues,
        key=lambda item: (
            0
            if item["severity"] == "critical"
            else 1,
            item["node"],
            item["category"],
        ),
    )

    parts = [
        f"I found {len(ordered)} "
        f"{'issue' if len(ordered) == 1 else 'issues'}."
    ]

    for index, item in enumerate(
        ordered,
        start=1,
    ):
        parts.append(
            f"Issue {index}: "
            f"{item['message']} "
            f"Evidence: {item['evidence']} "
            f"Next check: {item['next_check']}"
        )

    return " ".join(parts)


def describe_homelab_recovery() -> str:
    """
    Give safe, read-only recovery guidance based on current detected issues.

    BMO does not execute any fix here. It only explains the narrowest sensible
    next action for each fault category.
    """
    result = check_homelab_health()
    issues = result["issues"]

    if not issues:
        return (
            "Nothing needs recovery right now. "
            "The homelab health checks are all clear."
        )

    ordered = sorted(
        issues,
        key=lambda item: (
            0
            if item["severity"] == "critical"
            else 1,
            item["node"],
            item["category"],
        ),
    )

    parts = [
        (
            f"I have {len(ordered)} "
            f"{'recovery suggestion' if len(ordered) == 1 else 'recovery suggestions'}."
        )
    ]

    for index, item in enumerate(
        ordered,
        start=1,
    ):
        parts.append(
            (
                f"Suggestion {index}: "
                f"{item['message']} "
                f"{item['recovery_hint']}"
            )
        )

    return " ".join(parts)


if __name__ == "__main__":
    import json

    print(
        json.dumps(
            check_homelab_health(),
            indent=2,
        )
    )

    print()
    print("SUMMARY:")
    print(
        describe_homelab_health()
    )

    print()
    print("DIAGNOSTICS:")
    print(
        describe_homelab_diagnostics()
    )

    print()
    print("RECOVERY:")
    print(
        describe_homelab_recovery()
    )

