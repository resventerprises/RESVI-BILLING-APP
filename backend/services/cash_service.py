"""Cash drawer: opening/closing cash, expenses, and CASH-only sales.

Only physical cash affects the drawer: cash bills in full, plus the cash portion
of split payments. UPI and card go to the bank and are excluded entirely.
"""
from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy.orm import Session

from backend.services.timezone_util import IST, ist_date_key, ist_time_str
from database.models import Bill, CashDrawer, CashExpense


def _sync_expense_total(session: Session, drawer_date: str) -> float:
    """Recompute CashDrawer.cash_expenses as the sum of itemized expenses."""
    rows = session.query(CashExpense).filter(CashExpense.drawer_date == drawer_date).all()
    total = round(sum(r.amount or 0 for r in rows), 2)
    row = get_or_create(session, drawer_date)
    row.cash_expenses = total
    return total


def list_expenses(session: Session, drawer_date: str) -> list[dict]:
    rows = (
        session.query(CashExpense)
        .filter(CashExpense.drawer_date == drawer_date)
        .order_by(CashExpense.created_at.asc())
        .all()
    )
    return [{
        "id": r.id,
        "description": r.description,
        "amount": round(r.amount or 0, 2),
        "time": ist_time_str(r.created_at),
    } for r in rows]


def add_expense(session: Session, drawer_date: str, description: str, amount: float) -> dict:
    desc = (description or "").strip()
    if not desc:
        raise ValueError("Expense description is required.")
    amt = round(float(amount), 2)
    if amt < 0:
        raise ValueError("Expense amount cannot be negative.")
    row = CashExpense(drawer_date=drawer_date, description=desc, amount=amt)
    session.add(row)
    session.flush()
    _sync_expense_total(session, drawer_date)
    return {"id": row.id, "description": row.description, "amount": amt}


def edit_expense(session: Session, expense_id: int, description: str, amount: float) -> bool:
    row = session.get(CashExpense, expense_id)
    if not row:
        return False
    desc = (description or "").strip()
    if not desc:
        raise ValueError("Expense description is required.")
    amt = round(float(amount), 2)
    if amt < 0:
        raise ValueError("Expense amount cannot be negative.")
    row.description = desc
    row.amount = amt
    _sync_expense_total(session, row.drawer_date)
    return True


def delete_expense(session: Session, expense_id: int) -> bool:
    row = session.get(CashExpense, expense_id)
    if not row:
        return False
    dkey = row.drawer_date
    session.delete(row)
    session.flush()
    _sync_expense_total(session, dkey)
    return True


def cash_sales_for_date(session: Session, drawer_date: str) -> float:
    """Sum of CASH received on a given IST date: full amount of cash bills plus
    the cash slice of split payments. UPI/card excluded."""
    # Convert the IST day to a UTC window covering it.
    y, m, d = (int(x) for x in drawer_date.split("-"))
    start_ist = datetime(y, m, d, 0, 0, 0, tzinfo=IST)
    end_ist = start_ist + timedelta(days=1)
    start_utc = start_ist.astimezone(timezone.utc).replace(tzinfo=None)
    end_utc = end_ist.astimezone(timezone.utc).replace(tzinfo=None)

    bills = (
        session.query(Bill)
        .filter(Bill.bill_date >= start_utc, Bill.bill_date < end_utc)
        .all()
    )
    total = 0.0
    for b in bills:
        # Re-check the IST date precisely (window is inclusive-safe).
        if ist_date_key(b.bill_date) != drawer_date:
            continue
        method = (b.payment_method or "cash").lower()
        if method == "cash":
            total += b.grand_total or 0
        elif method == "split" and getattr(b, "payment_breakdown", None):
            try:
                parts = json.loads(b.payment_breakdown)
                total += float(parts.get("cash", 0) or 0)
            except (ValueError, TypeError):
                pass
        # upi / card contribute nothing to the drawer
    return round(total, 2)


def get_or_create(session: Session, drawer_date: str) -> CashDrawer:
    row = session.get(CashDrawer, drawer_date)
    if row is None:
        row = CashDrawer(drawer_date=drawer_date)
        session.add(row)
        session.flush()
    return row


def _serialize(session: Session, row: CashDrawer) -> dict:
    cash_sales = cash_sales_for_date(session, row.drawer_date)
    expenses = list_expenses(session, row.drawer_date)
    expense_total = round(sum(e["amount"] for e in expenses), 2)
    # Keep the stored total in sync (covers legacy rows / direct edits).
    expenses_amount = expense_total if expenses else round(row.cash_expenses or 0, 2)
    expected = round((row.opening_cash or 0) + cash_sales - expenses_amount, 2)
    actual = row.actual_cash
    difference = round((actual - expected), 2) if actual is not None else None
    return {
        "date": row.drawer_date,
        "opening_cash": round(row.opening_cash or 0, 2),
        "cash_sales": cash_sales,
        "cash_expenses": expenses_amount,
        "expenses": expenses,
        "expected_cash": expected,
        "actual_cash": round(actual, 2) if actual is not None else None,
        "difference": difference,
        "closing_cash": round(row.closing_cash, 2) if row.closing_cash is not None else None,
        "opened": row.opened,
        "closed": row.closed,
    }


def today_key() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d")


def yesterday_key() -> str:
    return (datetime.now(IST) - timedelta(days=1)).strftime("%Y-%m-%d")


def status(session: Session) -> dict:
    """Drawer status for today, plus whether an opening prompt is needed."""
    tkey = today_key()
    row = session.get(CashDrawer, tkey)
    opened = bool(row and row.opened)
    if row is None:
        # Transient (not added to the session) so polling doesn't create rows.
        row = CashDrawer(drawer_date=tkey, opening_cash=0.0, cash_expenses=0.0)
    data = _serialize(session, row)
    yrow = session.get(CashDrawer, yesterday_key())
    suggested_opening = (yrow.closing_cash if yrow and yrow.closing_cash is not None else 0)
    data["needs_opening"] = not opened
    data["suggested_opening"] = round(suggested_opening or 0, 2)
    data["yesterday_closing"] = round(yrow.closing_cash, 2) if (yrow and yrow.closing_cash is not None) else None
    return data


def open_day(session: Session, opening_cash: float) -> dict:
    row = get_or_create(session, today_key())
    row.opening_cash = round(float(opening_cash), 2)
    row.opened = True
    return _serialize(session, row)


def save_expenses(session: Session, expenses: float) -> dict:
    row = get_or_create(session, today_key())
    row.cash_expenses = round(float(expenses), 2)
    return _serialize(session, row)


def close_day(session: Session, drawer_date: str, expenses: float, actual_cash: float) -> dict:
    row = get_or_create(session, drawer_date)
    row.cash_expenses = round(float(expenses or 0), 2)
    row.actual_cash = round(float(actual_cash), 2)
    # Closing cash = what's physically counted; carries to tomorrow's opening.
    row.closing_cash = row.actual_cash
    row.closed = True
    return _serialize(session, row)


def history(session: Session, limit: int = 60) -> list[dict]:
    rows = (
        session.query(CashDrawer)
        .order_by(CashDrawer.drawer_date.desc())
        .limit(limit)
        .all()
    )
    return [_serialize(session, r) for r in rows]
