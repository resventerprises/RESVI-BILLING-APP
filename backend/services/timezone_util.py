"""Single source of truth for displaying times in the shop's timezone (IST).

Bills are stored in UTC. Everything shown to the user — UI, reports, PDFs — must
be converted to Asia/Kolkata so the times always match.
"""
from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")


def to_ist(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    # Treat naive datetimes as UTC (that's how they're stored).
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(IST)


def ist_date_str(dt: datetime | None) -> str:
    d = to_ist(dt)
    return d.strftime("%d-%m-%Y") if d else "-"


def ist_time_str(dt: datetime | None) -> str:
    d = to_ist(dt)
    return d.strftime("%I:%M %p") if d else "-"


def ist_date_key(dt: datetime | None) -> str:
    """YYYY-MM-DD in IST — used for grouping bills by shop-day."""
    d = to_ist(dt)
    return d.strftime("%Y-%m-%d") if d else ""


def ist_now_str() -> str:
    return datetime.now(IST).strftime("%d-%m-%Y %I:%M %p")
