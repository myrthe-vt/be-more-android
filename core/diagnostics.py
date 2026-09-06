"""
Small read-only diagnostics helpers for BMO.

Important design rule:
diagnostics must never make an optional integration required.

This module therefore avoids initializing Spotify, Google Calendar,
weather, vision, or other optional services merely to inspect them.
"""

from __future__ import annotations

import contextlib
import importlib
import io
import os
from pathlib import Path
from datetime import datetime, timezone
from typing import Any

import requests

from core.logging_setup import (
    LOG_FILE,
    PROJECT_ROOT,
)


def _result(
    status: str,
    detail: str = "",
) -> dict[str, str]:
    return {
        "status": status,
        "detail": detail,
    }


def _safe_config():
    """
    Import core.config while suppressing its legacy informational prints.

    core.config is already a required BMO module, not an optional
    integration.
    """

    try:
        with contextlib.redirect_stdout(
            io.StringIO()
        ):
            return importlib.import_module(
                "core.config"
            )
    except Exception:
        return None


def _check_http_backend(
    llm_url: str | None,
) -> dict[str, str]:
    if not llm_url:
        return _result(
            "unavailable",
            "LLM_URL is not configured",
        )

    try:
        base_url = llm_url.replace(
            "/api/chat",
            "",
        )

        response = requests.get(
            base_url,
            timeout=2,
        )

        if response.status_code == 200:
            return _result(
                "ok",
                base_url,
            )

        return _result(
            "error",
            f"HTTP {response.status_code} from {base_url}",
        )

    except requests.RequestException as exc:
        return _result(
            "offline",
            str(exc),
        )

    except Exception as exc:
        return _result(
            "error",
            str(exc),
        )


def _check_path(
    value: Any,
    *,
    missing_label: str,
) -> dict[str, str]:
    if value is None:
        return _result(
            "unavailable",
            missing_label,
        )

    text = str(value).strip()

    if not text:
        return _result(
            "unavailable",
            missing_label,
        )

    try:
        path = Path(
            text
        ).expanduser()

        if path.exists():
            return _result(
                "ok",
                str(path),
            )

        return _result(
            "missing",
            str(path),
        )

    except Exception as exc:
        return _result(
            "error",
            str(exc),
        )


def _check_disk() -> dict[str, Any]:
    try:
        usage = os.statvfs(
            PROJECT_ROOT
        )

        free_bytes = (
            usage.f_bavail *
            usage.f_frsize
        )

        total_bytes = (
            usage.f_blocks *
            usage.f_frsize
        )

        free_gb = round(
            free_bytes /
            (1024 ** 3),
            1,
        )

        total_gb = round(
            total_bytes /
            (1024 ** 3),
            1,
        )

        status = (
            "ok"
            if free_gb >= 5
            else "warning"
        )

        return {
            "status": status,
            "free_gb": free_gb,
            "total_gb": total_gb,
            "detail": (
                f"{free_gb} GB free "
                f"of {total_gb} GB"
            ),
        }

    except Exception as exc:
        return {
            "status": "error",
            "detail": str(exc),
        }


def _check_calendar() -> dict[str, str]:
    credentials = (
        PROJECT_ROOT /
        "credentials.google-calendar.json"
    )

    token = (
        PROJECT_ROOT /
        "token.google-calendar.json"
    )

    selection = (
        PROJECT_ROOT /
        "calendar_selection.json"
    )

    if token.exists():
        if selection.exists():
            return _result(
                "configured",
                "token + calendar selection present",
            )

        return _result(
            "configured",
            "token present",
        )

    if credentials.exists():
        return _result(
            "authorization_required",
            "credentials present, token missing",
        )

    return _result(
        "not_configured",
        "Google Calendar credentials not present",
    )


def _module_present(
    relative_path: str,
    *,
    available_detail: str,
) -> dict[str, str]:
    path = (
        PROJECT_ROOT /
        relative_path
    )

    if path.exists():
        return _result(
            "available",
            available_detail,
        )

    return _result(
        "unavailable",
        f"{relative_path} not present",
    )


def _last_log_error() -> dict[str, str]:
    if not LOG_FILE.exists():
        return _result(
            "none",
            "log file has not been created yet",
        )

    try:
        lines = LOG_FILE.read_text(
            encoding="utf-8",
            errors="replace",
        ).splitlines()

        for line in reversed(
            lines[-1000:]
        ):
            if (
                " ERROR " in line
                or " CRITICAL " in line
            ):
                return _result(
                    "found",
                    line[-500:],
                )

        return _result(
            "none",
            "no ERROR/CRITICAL entries in recent log",
        )

    except Exception as exc:
        return _result(
            "unavailable",
            str(exc),
        )


def get_diagnostics() -> dict[str, Any]:
    """
    Return a read-only diagnostics snapshot.

    Every probe is isolated so one broken component cannot break the
    diagnostics endpoint itself.
    """

    config = _safe_config()

    llm_url = (
        getattr(
            config,
            "LLM_URL",
            None,
        )
        if config
        else None
    )

    piper_cmd = (
        getattr(
            config,
            "PIPER_CMD",
            None,
        )
        if config
        else None
    )

    piper_model = (
        getattr(
            config,
            "PIPER_MODEL",
            None,
        )
        if config
        else None
    )

    whisper_cmd = (
        getattr(
            config,
            "WHISPER_CMD",
            None,
        )
        if config
        else None
    )

    whisper_model = (
        getattr(
            config,
            "WHISPER_MODEL",
            None,
        )
        if config
        else None
    )

    vision_model = (
        getattr(
            config,
            "VISION_MODEL",
            None,
        )
        if config
        else None
    )

    core = {
        "backend": _check_http_backend(
            llm_url
        ),
        "piper_binary": _check_path(
            piper_cmd,
            missing_label="Piper command unavailable",
        ),
        "piper_model": _check_path(
            piper_model,
            missing_label="Piper model unavailable",
        ),
        "whisper_binary": _check_path(
            whisper_cmd,
            missing_label="Whisper command unavailable",
        ),
        "whisper_model": _check_path(
            whisper_model,
            missing_label="Whisper model unavailable",
        ),
        "disk": _check_disk(),
    }

    optional = {
        "calendar": _check_calendar(),

        # These deliberately describe capability/config presence only.
        # They do not initialize or call the integrations.
        "spotify": _module_present(
            "core/spotify.py",
            available_detail="Spotify support module present",
        ),

        "weather": _module_present(
            "core/weather.py",
            available_detail="Weather support module present",
        ),

        "vision": (
            _result(
                "configured",
                str(
                    vision_model
                ),
            )
            if vision_model
            else _result(
                "not_configured",
                "No vision model configured",
            )
        ),
    }

    required_bad_states = {
        "error",
        "missing",
        "offline",
        "unavailable",
    }

    overall = (
        "degraded"
        if any(
            item.get("status")
            in required_bad_states
            for item in core.values()
        )
        else "ok"
    )

    return {
        "status": overall,
        "generated_at": datetime.now(
            timezone.utc
        ).isoformat(),
        "core": core,
        "optional": optional,
        "logging": {
            "file": str(
                LOG_FILE
            ),
            "rotation": {
                "max_mb": 5,
                "backups": 3,
            },
            "last_error": _last_log_error(),
        },
    }
