"""
Central application settings for RESVI.

Single source of truth for paths, database URL, and runtime flags.
Everything is overridable through environment variables so the same code
runs unchanged on a dev laptop, the shop server, and (later) the Android
sync server. No module elsewhere should hardcode a path or threshold.
"""
from __future__ import annotations

import os
from pathlib import Path


def _env(key: str, default: str) -> str:
    return os.environ.get(key, default)


def _env_bool(key: str, default: bool) -> bool:
    raw = os.environ.get(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# --- Paths -------------------------------------------------------------------
BASE_DIR: Path = Path(__file__).resolve().parent.parent
UPLOAD_DIR: Path = Path(_env("RESVI_UPLOAD_DIR", str(BASE_DIR / "uploads" / "products")))
STATIC_DIR: Path = BASE_DIR / "static"
TEMPLATE_DIR: Path = BASE_DIR / "templates"
INDEX_DIR: Path = Path(_env("RESVI_INDEX_DIR", str(BASE_DIR / "uploads" / "_index")))

# --- Database ----------------------------------------------------------------
# SQLite for v1. The whole stack talks to SQLAlchemy, so swapping to
# Postgres/MySQL later is a URL change plus a migration, not a rewrite.
DEFAULT_SQLITE_URL = f"sqlite:///{BASE_DIR / 'resvi.db'}"
DATABASE_URL: str = _env("RESVI_DATABASE_URL", DEFAULT_SQLITE_URL)
SQL_ECHO: bool = _env_bool("RESVI_SQL_ECHO", False)

# --- Code formats ------------------------------------------------------------
PRODUCT_CODE_PREFIX: str = _env("RESVI_PRODUCT_CODE_PREFIX", "P")
BARCODE_START: int = int(_env("RESVI_BARCODE_START", "1000"))  # first generated = 1001
PRODUCT_CODE_PADDING: int = int(_env("RESVI_PRODUCT_CODE_PADDING", "6"))
BILL_NUMBER_PREFIX: str = _env("RESVI_BILL_NUMBER_PREFIX", "BILL-")
BILL_NUMBER_PADDING: int = int(_env("RESVI_BILL_NUMBER_PADDING", "6"))

# --- Product image rules -----------------------------------------------------
MIN_PRODUCT_IMAGES: int = int(_env("RESVI_MIN_PRODUCT_IMAGES", "3"))
MAX_PRODUCT_IMAGES: int = int(_env("RESVI_MAX_PRODUCT_IMAGES", "10"))
ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}

# --- App ---------------------------------------------------------------------
APP_NAME: str = "RESVI"
APP_VERSION: str = "0.9.9-manual-items"  # fixed bill footer, manual one-off items
DEBUG: bool = _env_bool("RESVI_DEBUG", True)


def ensure_runtime_dirs() -> None:
    """Create writable directories the app needs at boot."""
    for path in (UPLOAD_DIR, INDEX_DIR):
        path.mkdir(parents=True, exist_ok=True)
