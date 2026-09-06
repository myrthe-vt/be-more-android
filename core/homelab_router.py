from __future__ import annotations

import re
from typing import Optional

from core.homelab import (
    containers,
    disk_usage,
    homelab_overview,
    node_online,
    service_status,
    system_status,
)

from core.homelab_health import (
    describe_homelab_diagnostics,
    describe_homelab_health,
    describe_homelab_recovery,
)


NODE_ALIASES = {
    "media server": "media",
    "primary": "primary",
    "primary server": "primary",
    "media": "media",
    "local": "local",
    "mac": "local",
    "macbook": "local",
}


SERVICE_ALIASES = {
    "jellyfin": "jellyfin",
    "sonarr": "sonarr",
    "radarr": "radarr",
    "prowlarr": "prowlarr",
    "bazarr": "bazarr",
    "qbittorrent": "qbittorrent",
    "qbit": "qbittorrent",
    "qbit torrent": "qbittorrent",
    "gluetun": "gluetun",
    "immich": "immich",
    "audiobookshelf": "audiobookshelf",
    "paperless": "paperless",
    "paperless ngx": "paperless",
    "bookstack": "bookstack",
    "syncthing": "syncthing",
    "vaultwarden": "vaultwarden",
    "homepage": "homepage",
    "uptime kuma": "uptime-kuma",
    "uptime-kuma": "uptime-kuma",
    "adguard": "adguard",
    "dozzle": "dozzle",
}


def _normalize(text: str) -> str:
    return re.sub(
        r"\s+",
        " ",
        text.strip().lower(),
    )


def _find_node(
    text: str,
) -> Optional[str]:
    normalized = _normalize(text)

    for phrase, node in sorted(
        NODE_ALIASES.items(),
        key=lambda item: len(item[0]),
        reverse=True,
    ):
        if phrase in normalized:
            return node

    return None


def _find_service(
    text: str,
) -> Optional[str]:
    normalized = _normalize(text)

    for phrase, service in sorted(
        SERVICE_ALIASES.items(),
        key=lambda item: len(item[0]),
        reverse=True,
    ):
        if phrase in normalized:
            return service

    return None


def _is_health_overview_request(
    normalized: str,
) -> bool:
    health_phrases = (
        "anything wrong",
        "anything broken",
        "anything down",
        "any problems",
        "any issues",
        "everything okay",
        "everything ok",
        "everything healthy",
        "homelab healthy",
        "homelab health",
        "health check",
        "check the homelab",
        "check my homelab",
        "is the homelab okay",
        "is the homelab ok",
        "is my homelab okay",
        "is my homelab ok",
    )

    return any(
        phrase in normalized
        for phrase in health_phrases
    )


def _is_diagnostics_request(
    normalized: str,
) -> bool:
    diagnostic_phrases = (
        "what exactly is wrong",
        "what is wrong with the homelab",
        "what's wrong with the homelab",
        "whats wrong with the homelab",
        "why is the homelab unhealthy",
        "why is my homelab unhealthy",
        "diagnose the homelab",
        "diagnose my homelab",
        "homelab diagnostics",
        "give me diagnostics",
        "explain the homelab problem",
        "explain the problem",
        "what should i check",
    )

    return any(
        phrase in normalized
        for phrase in diagnostic_phrases
    )


def _is_recovery_request(
    normalized: str,
) -> bool:
    recovery_phrases = (
        "how should i fix the homelab",
        "how do i fix the homelab",
        "how can i fix the homelab",
        "how should i fix this",
        "how do i fix this",
        "how can i fix this",
        "what should i do about it",
        "what should i do about this",
        "what should i do next",
        "how should i recover",
        "recovery suggestions",
        "suggest a fix",
        "suggest fixes",
        "what can i do to fix it",
        "what can i do to fix this",
    )

    return any(
        phrase in normalized
        for phrase in recovery_phrases
    )


def is_homelab_request(text: str) -> bool:
    normalized = _normalize(text)

    if _find_node(normalized):
        return True

    if _find_service(normalized):
        return True

    if _is_recovery_request(normalized):
        return True

    if _is_diagnostics_request(normalized):
        return True

    if _is_health_overview_request(normalized):
        return True

    homelab_phrases = (
        "homelab",
        "home lab",
        "containers",
        "docker containers",
        "servers online",
        "servers running",
    )

    return any(
        phrase in normalized
        for phrase in homelab_phrases
    )


def handle_homelab_request(
    text: str,
) -> Optional[str]:
    normalized = _normalize(text)

    service = _find_service(normalized)
    node = _find_node(normalized)

    # ---------------------------------------------------------
    # Recovery suggestions
    # ---------------------------------------------------------

    if _is_recovery_request(normalized):
        return describe_homelab_recovery()

    # ---------------------------------------------------------
    # Detailed diagnostics
    # ---------------------------------------------------------

    if _is_diagnostics_request(normalized):
        return describe_homelab_diagnostics()

    # ---------------------------------------------------------
    # Whole-homelab health check
    # ---------------------------------------------------------

    if _is_health_overview_request(normalized):
        return describe_homelab_health()

    # ---------------------------------------------------------
    # Named service status
    # ---------------------------------------------------------

    if service:
        status = service_status(service)

        if not status.get("ok"):
            error = status.get(
                "error",
                "I couldn't check that service.",
            )

            return (
                f"I couldn't check {service}. "
                f"{error}"
            )

        node_name = status.get(
            "node_name",
            status.get(
                "node",
                "the server",
            ),
        )

        if status.get("running"):
            container_status = status.get(
                "status",
                "running",
            )

            return (
                f"{service} is running on "
                f"{node_name}. "
                f"Its container reports: "
                f"{container_status}."
            )

        return (
            f"{service} is not currently "
            f"running on {node_name}."
        )

    # ---------------------------------------------------------
    # Container listing
    # ---------------------------------------------------------

    container_words = (
        "container",
        "containers",
        "docker",
        "what's running",
        "whats running",
        "what is running",
    )

    if any(
        phrase in normalized
        for phrase in container_words
    ):
        if not node:
            return (
                "Which machine do you mean, "
                "primary or Media?"
            )

        result = containers(node)

        if not result.get("ok"):
            return (
                f"I couldn't read the containers "
                f"on {result.get('name', node)}. "
                f"{result.get('error', '')}"
            ).strip()

        names = [
            item["name"]
            for item in result.get(
                "containers",
                [],
            )
        ]

        display_name = result.get(
            "name",
            node,
        )

        if not names:
            return (
                f"There are no running Docker "
                f"containers on {display_name}."
            )

        return (
            f"{display_name} has "
            f"{len(names)} running containers: "
            f"{', '.join(names)}."
        )

    # ---------------------------------------------------------
    # Disk usage
    # ---------------------------------------------------------

    disk_phrases = (
        "disk",
        "storage",
        "space left",
        "space free",
        "free space",
        "how full",
        "how much space",
    )

    if any(
        phrase in normalized
        for phrase in disk_phrases
    ):
        if not node:
            return (
                "Which machine's storage "
                "do you want me to check?"
            )

        disk_name = "system"

        if node == "media":
            disk_name = "storage"

        elif node == "primary":
            disk_name = "external"

        result = disk_usage(
            node,
            disk_name,
        )

        if not result.get("ok"):
            return (
                f"I couldn't check storage on "
                f"{result.get('name', node)}. "
                f"{result.get('error', '')}"
            ).strip()

        return (
            f"{result['name']} has "
            f"{result['available']} free on "
            f"{result['path']}. "
            f"It's {result['percent_used']} used, "
            f"with {result['used']} used out of "
            f"{result['size']}."
        )

    # ---------------------------------------------------------
    # General node health/status
    # ---------------------------------------------------------

    health_phrases = (
        "how is",
        "how's",
        "hows",
        "status",
        "doing",
        "okay",
        "healthy",
        "health",
    )

    if node and any(
        phrase in normalized
        for phrase in health_phrases
    ):
        result = system_status(node)

        if not result.get("ok"):
            return (
                f"I couldn't get the status of "
                f"{result.get('name', node)}. "
                f"{result.get('error', '')}"
            ).strip()

        details = []

        uptime = result.get("uptime")

        if uptime:
            details.append(
                f"uptime is {uptime}"
            )

        load = result.get("load")

        if load:
            details.append(
                f"load averages are {load}"
            )

        memory = result.get("memory")

        if memory:
            details.append(
                f"memory use is {memory}"
            )

        temperature = result.get(
            "temperature_c"
        )

        if temperature is not None:
            details.append(
                f"temperature is "
                f"{temperature} degrees Celsius"
            )

        if not details:
            return (
                f"{result['name']} is online."
            )

        return (
            f"{result['name']} is online. "
            + ". ".join(details)
            + "."
        )

    # ---------------------------------------------------------
    # Node online check
    # ---------------------------------------------------------

    online_phrases = (
        "online",
        "up",
        "running",
        "reachable",
        "alive",
    )

    if node and any(
        phrase in normalized
        for phrase in online_phrases
    ):
        result = node_online(node)

        if result.get("online"):
            return (
                f"{result['name']} is online."
            )

        return (
            f"{result['name']} appears to be "
            "offline or unreachable."
        )

    # ---------------------------------------------------------
    # Whole homelab overview
    # ---------------------------------------------------------

    if (
        "homelab" in normalized
        or "home lab" in normalized
        or "servers" in normalized
    ):
        result = homelab_overview()

        statuses = []

        for item in result["nodes"].values():
            name = item["name"]

            if item.get("online"):
                statuses.append(
                    f"{name} is online"
                )
            else:
                statuses.append(
                    f"{name} is offline"
                )

        return (
            "Homelab status: "
            + ", ".join(statuses)
            + "."
        )

    return None


if __name__ == "__main__":
    TESTS = [
        "Is anything wrong with the homelab?",
        "What exactly is wrong with the homelab?",
        "Diagnose my homelab.",
        "What should I check?",
        "How should I fix the homelab?",
        "What should I do next?",
        "Suggest a fix.",
        "Is everything okay?",
        "Give the homelab a health check.",
        "Is Media online?",
        "Is the primary online?",
        "Is Jellyfin running?",
        "Is qBittorrent running?",
        "How much space is left on Media?",
        "How much storage is left on the primary?",
        "What containers are running on Media?",
        "What's running on the primary?",
        "How is Media doing?",
        "How is the homelab doing?",
    ]

    for question in TESTS:
        print()
        print(
            f"> {question}"
        )
        print(
            handle_homelab_request(question)
        )

