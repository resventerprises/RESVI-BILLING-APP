"""
Inventory service.

Every quantity change is recorded as a StockMovement (in / out / adjust) and the
product's running quantity is updated. Sales call record_sale_out() at bill
completion. Low-stock and out-of-stock status are derived from quantity vs
min_stock_level.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from database.crud import repositories as repo
from database.models import Product, StockMovement
from utils.validators import ValidationError


def _move(session: Session, product: Product, mtype: str, signed_qty: int,
          reference: str | None = None, remarks: str | None = None) -> StockMovement:
    product.quantity = (product.quantity or 0) + signed_qty
    if product.quantity < 0:
        product.quantity = 0
    m = StockMovement(
        product_id=product.id,
        movement_type=mtype,
        quantity=signed_qty,
        balance_after=product.quantity,
        reference=reference,
        remarks=remarks,
    )
    session.add(m)
    session.flush()
    return m


def stock_in(session: Session, product_id: int, qty: int, remarks: str | None = None) -> StockMovement:
    product = repo.products.get(session, product_id)
    if product is None:
        raise ValidationError("Product not found.")
    qty = int(qty)
    if qty <= 0:
        raise ValidationError("Stock-in quantity must be greater than zero.")
    return _move(session, product, "in", qty, remarks=remarks or "Stock added")


def adjust(session: Session, product_id: int, delta: int, remarks: str | None = None) -> StockMovement:
    product = repo.products.get(session, product_id)
    if product is None:
        raise ValidationError("Product not found.")
    delta = int(delta)
    if delta == 0:
        raise ValidationError("Adjustment cannot be zero.")
    return _move(session, product, "adjust", delta, remarks=remarks or "Manual adjustment")


def record_sale_out(session: Session, product_id: int, qty: int, bill_number: str) -> None:
    product = repo.products.get(session, product_id)
    if product is None:
        return
    _move(session, product, "out", -abs(int(qty)), reference=bill_number, remarks="Sale")


def history(session: Session, product_id: int | None = None, limit: int = 100) -> list[dict]:
    stmt = select(StockMovement).order_by(StockMovement.created_at.desc()).limit(limit)
    if product_id is not None:
        stmt = stmt.where(StockMovement.product_id == product_id)
    rows = session.scalars(stmt).all()
    out = []
    for m in rows:
        p = repo.products.get(session, m.product_id)
        out.append({
            "id": m.id,
            "product_id": m.product_id,
            "product_name": p.product_name if p else "—",
            "type": m.movement_type,
            "quantity": m.quantity,
            "balance_after": m.balance_after,
            "reference": m.reference,
            "remarks": m.remarks,
            "date": m.created_at.isoformat(),
        })
    return out


def stock_status(product: Product) -> str:
    if (product.quantity or 0) <= 0:
        return "out"
    if product.min_stock_level and product.quantity <= product.min_stock_level:
        return "low"
    return "ok"


def inventory_list(session: Session, only_low: bool = False) -> list[dict]:
    products = repo.products.search(session, only_active=False, limit=1000)
    rows = []
    for p in products:
        st = stock_status(p)
        if only_low and st == "ok":
            continue
        rows.append({
            "id": p.id,
            "product_code": p.product_code,
            "product_name": p.product_name,
            "quantity": p.quantity or 0,
            "min_stock_level": p.min_stock_level or 0,
            "cost_price": p.cost_price or 0,
            "selling_price": p.selling_price,
            "stock_status": st,
        })
    rows.sort(key=lambda r: {"out": 0, "low": 1, "ok": 2}[r["stock_status"]])
    return rows


def counts(session: Session) -> dict:
    products = repo.products.search(session, only_active=False, limit=10000)
    low = sum(1 for p in products if stock_status(p) == "low")
    out = sum(1 for p in products if stock_status(p) == "out")
    return {"low_stock": low, "out_of_stock": out}
