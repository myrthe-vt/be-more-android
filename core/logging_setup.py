"""
Shared logging setup for BMO.

The web backend keeps its normal console logging while also writing a
small rotating application log under logs/bmo.log.

Rotation policy:
- 5 MiB per file
- 3 backups
- about 20 MiB maximum total
"""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
LOG_DIR = PROJECT_ROOT / "logs"
LOG_FILE = LOG_DIR / "bmo.log"

LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 3

_HANDLER_MARKER = "_bmo_rotating_file_handler"


def configure_logging(
    level: int = logging.INFO,
) -> Path:
    """
    Configure BMO logging without disturbing uvicorn or other existing
    console handlers.

    Safe to call more than once.
    """

    LOG_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s "
        "%(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    already_has_bmo_file_handler = any(
        getattr(
            handler,
            _HANDLER_MARKER,
            False,
        )
        for handler in root_logger.handlers
    )

    if not already_has_bmo_file_handler:
        file_handler = RotatingFileHandler(
            LOG_FILE,
            maxBytes=LOG_MAX_BYTES,
            backupCount=LOG_BACKUP_COUNT,
            encoding="utf-8",
        )

        file_handler.setLevel(level)
        file_handler.setFormatter(formatter)

        setattr(
            file_handler,
            _HANDLER_MARKER,
            True,
        )

        root_logger.addHandler(
            file_handler
        )

    # Preserve whatever console setup uvicorn already owns. If BMO is
    # launched directly without one, add a normal console handler.
    has_console_handler = any(
        isinstance(
            handler,
            logging.StreamHandler,
        )
        and not isinstance(
            handler,
            RotatingFileHandler,
        )
        for handler in root_logger.handlers
    )

    if not has_console_handler:
        console_handler = logging.StreamHandler()
        console_handler.setLevel(level)
        console_handler.setFormatter(formatter)

        root_logger.addHandler(
            console_handler
        )

    # Third-party HTTP internals are useful only when something is wrong.
    # Keep their WARNING/ERROR output while preventing routine successful
    # requests from drowning out BMO's own operational log.
    logging.getLogger(
        "primp"
    ).setLevel(
        logging.WARNING
    )

    return LOG_FILE
