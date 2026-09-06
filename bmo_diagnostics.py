#!/usr/bin/env python3
"""
Read-only command-line diagnostics for BMO.
"""

from __future__ import annotations

from core.diagnostics import get_diagnostics


def _print_item(
    label: str,
    item: dict,
) -> None:
    status = item.get(
        "status",
        "unknown",
    )

    detail = item.get(
        "detail",
        "",
    )

    if detail:
        print(
            f"{label:<18} {status:<22} {detail}"
        )
    else:
        print(
            f"{label:<18} {status}"
        )


def main() -> None:
    data = get_diagnostics()

    print()
    print("BMO diagnostics")
    print("=" * 60)
    print(
        f"Overall           {data['status']}"
    )
    print(
        f"Generated         {data['generated_at']}"
    )

    print()
    print("CORE")

    labels = {
        "backend": "Backend",
        "piper_binary": "Piper binary",
        "piper_model": "Piper model",
        "whisper_binary": "Whisper binary",
        "whisper_model": "Whisper model",
        "disk": "Disk",
    }

    for key, label in labels.items():
        _print_item(
            label,
            data["core"][key],
        )

    print()
    print("OPTIONAL")

    optional_labels = {
        "calendar": "Calendar",
        "spotify": "Spotify",
        "weather": "Weather",
        "vision": "Vision",
    }

    for key, label in optional_labels.items():
        _print_item(
            label,
            data["optional"][key],
        )

    print()
    print("LOGGING")

    print(
        f"{'Log file':<18} "
        f"{data['logging']['file']}"
    )

    rotation = (
        data["logging"]["rotation"]
    )

    print(
        f"{'Rotation':<18} "
        f"{rotation['max_mb']} MB, "
        f"{rotation['backups']} backups"
    )

    _print_item(
        "Last error",
        data["logging"]["last_error"],
    )

    print()


if __name__ == "__main__":
    main()
