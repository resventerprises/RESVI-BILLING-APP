"""Manual daily-sales entries.

Revenue typed in by hand for days when the billing system was unavailable. This
data is used ONLY for revenue reporting — it never creates bills, never touches
stock, and never appears in product-wise sales. One entry per date.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.services.timezone_util import IST, ist_date_str, ist_time_str
from database.models import ManualSale
from utils.validators import ValidationError


def _serialize(r: ManualSale) -> dict:
    return {
        "id": r.id,
        "date": r.sale_date,
        "amount": round(r.amount or 0, 2),
        "note": r.note or "",
        "created_by": r.created_by or "",
        "created_at_date": ist_date_str(r.created_at) if r.created_at else "",
        "created_at_time": ist_time_str(r.created_at) if r.created_at else "",
        "updated_at_date": ist_date_str(r.updated_at) if r.updated_at else "",
        "updated_at_time": ist_time_str(r.updated_at) if r.updated_at else "",
    }


def get_for_date(session: Session, sale_date: str) -> dict | None:
    r = session.scalar(select(ManualSale).where(ManualSale.sale_date == sale_date))
    return _serialize(r) if r else None


def upsert(session: Session, sale_date: str, amount: float,
           note: str | None = None, created_by: str | None = None) -> dict:
    """Create or update the manual entry for a date."""
    if not sale_date:
        raise ValidationError("A date is required.")
    try:
        datetime.strptime(sale_date, "%Y-%m-%d")
    except (ValueError, TypeError):
        raise ValidationError("Date must be YYYY-MM-DD.")
    try:
        amt = round(float(amount), 2)
    except (TypeError, ValueError):
        raise ValidationError("Amount must be a number.")
    if amt < 0:
        raise ValidationError("Amount cannot be negative.")

    r = session.scalar(select(ManualSale).where(ManualSale.sale_date == sale_date))
    if r:
        r.amount = amt
        r.note = note
    else:
        r = ManualSale(sale_date=sale_date, amount=amt, note=note,
                       created_by=(created_by or "shop"))
        session.add(r)
    session.flush()
    return _serialize(r)


def delete_for_date(session: Session, sale_date: str) -> bool:
    r = session.scalar(select(ManualSale).where(ManualSale.sale_date == sale_date))
    if not r:
        return False
    session.delete(r)
    return True


def list_all(session: Session, limit: int = 200) -> list[dict]:
    rows = session.scalars(
        select(ManualSale).order_by(ManualSale.sale_date.desc()).limit(limit)
    ).all()
    return [_serialize(r) for r in rows]


def total_for_ist_range(session: Session, start_ist_date: str, end_ist_date: str) -> float:
    """Sum manual amounts whose sale_date falls in [start, end] (inclusive), by
    IST date string comparison (sale_date is stored as an IST YYYY-MM-DD)."""
    rows = session.scalars(
        select(ManualSale).where(
            ManualSale.sale_date >= start_ist_date,
            ManualSale.sale_date <= end_ist_date,
        )
    ).all()
    return round(sum(r.amount or 0 for r in rows), 2)


def items_for_ist_range(session: Session, start_ist_date: str, end_ist_date: str) -> list[dict]:
    rows = session.scalars(
        select(ManualSale).where(
            ManualSale.sale_date >= start_ist_date,
            ManualSale.sale_date <= end_ist_date,
        ).order_by(ManualSale.sale_date.desc())
    ).all()
    return [_serialize(r) for r in rows]


def _utc_to_ist_date(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(IST).strftime("%Y-%m-%d")
