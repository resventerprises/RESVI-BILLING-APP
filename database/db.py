"""
Database engine and session management.

The application never imports SQLAlchemy engine details directly; it goes
through get_session() / session_scope(). That indirection is what makes the
SQLite -> Postgres migration a configuration change instead of a refactor.
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from config import settings

# Render (and Heroku) hand out DATABASE_URL as 'postgres://...', but SQLAlchemy
# 2.x requires the 'postgresql://' scheme, and we pin the psycopg (v3) driver.
_db_url = settings.DATABASE_URL
if _db_url.startswith("postgres://"):
    _db_url = _db_url.replace("postgres://", "postgresql+psycopg://", 1)
elif _db_url.startswith("postgresql://") and "+psycopg" not in _db_url:
    _db_url = _db_url.replace("postgresql://", "postgresql+psycopg://", 1)

_is_sqlite = _db_url.startswith("sqlite")

# SQLite needs check_same_thread=False to be used from Flask's worker threads.
# Other backends ignore this connect arg.
_connect_args = {"check_same_thread": False} if _is_sqlite else {}

# pool_pre_ping avoids stale-connection errors on managed Postgres (Render can
# drop idle connections); harmless for SQLite.
_engine_kwargs = {} if _is_sqlite else {"pool_pre_ping": True, "pool_recycle": 300}

engine = create_engine(
    _db_url,
    echo=settings.SQL_ECHO,
    future=True,
    connect_args=_connect_args,
    **_engine_kwargs,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_session() -> Session:
    """Return a new session. Caller owns its lifecycle."""
    return SessionLocal()


@contextmanager
def session_scope() -> Iterator[Session]:
    """Transactional scope: commit on success, rollback on error, always close."""
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def _ensure_columns() -> None:
    """Add columns introduced after a DB was first created (SQLite-safe).

    SQLAlchemy's create_all never ALTERs existing tables, so when new fields are
    added (inventory, payment method) an existing shop DB would be missing them.
    This adds any missing columns in place, preserving all data.
    """
    from sqlalchemy import inspect, text

    additions = {
        "products": [
            ("cost_price", "FLOAT NOT NULL DEFAULT 0"),
            ("quantity", "INTEGER NOT NULL DEFAULT 0"),
            ("min_stock_level", "INTEGER NOT NULL DEFAULT 0"),
            ("description", "TEXT"),
            ("barcode", "VARCHAR(64)"),
            ("family_key", "VARCHAR(120)"),
            ("import_batch_id", "INTEGER"),
        ],
        "bills": [
            ("payment_method", "VARCHAR(16) NOT NULL DEFAULT 'cash'"),
            ("payment_breakdown", "TEXT"),
        ],
        "bill_items": [
            ("item_name", "VARCHAR(200)"),
        ],
        "import_batches": [
            ("status", "VARCHAR(16) NOT NULL DEFAULT 'active'"),
        ],
    }
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    with engine.begin() as conn:
        for table, cols in additions.items():
            if table not in existing_tables:
                continue
            have = {c["name"] for c in inspector.get_columns(table)}
            for name, ddl in cols:
                if name not in have:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
        # Manual bill items have no product_id, so relax the old NOT NULL
        # constraint on existing PostgreSQL databases (no-op on SQLite).
        if "bill_items" in existing_tables and engine.dialect.name == "postgresql":
            try:
                conn.execute(text("ALTER TABLE bill_items ALTER COLUMN product_id DROP NOT NULL"))
            except Exception:
                pass


def init_db() -> None:
    """Create all tables, then apply additive column migrations. Idempotent."""
    from database import models  # noqa: F401  (registers mappers)

    models.Base.metadata.create_all(bind=engine)
    _ensure_columns()
