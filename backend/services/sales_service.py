"""History and daily-sales read models."""
from __future__ import annotations

from sqlalchemy.orm import Session

from backend.services.billing_service import serialize_bill
from database.crud import repositories as repo
from utils.validators import ValidationError


def bill_history(session: Session, limit: int = 50) -> list[dict]:
    return [serialize_bill(b, session) for b in repo.bills.recent(session, limit)]


def bill_detail(session: Session, bill_id: int) -> dict:
    bill = repo.bills.get(session, bill_id)
    if bill is None:
        raise ValidationError("Bill not found.")
    return serialize_bill(bill, session, with_items=True)


def daily_sales(session: Session, limit: int = 30) -> list[dict]:
    return [
        {
            "date": s.sale_date,
            "num_bills": s.num_bills,
            "total_sales": round(s.total_sales, 2),
            "total_discount": round(s.total_discount, 2),
            "net_sales": round(s.net_sales, 2),
        }
        for s in repo.daily_sales.recent(session, limit)
    ]
