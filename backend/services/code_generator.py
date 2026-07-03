"""
Code generation for product codes (P000001...) and bill numbers (BILL-000001...).

Backed by the Sequences table, not MAX(id)+1, so a deleted product's code is
never handed out again — exactly as Part 3 requires. The increment runs inside
the caller's transaction; a UNIQUE constraint on the target column is the final
guard against any race.
"""
from __future__ import annotations

from sqlalchemy import update
from sqlalchemy.orm import Session

from config import settings
from database.models import Sequence

PRODUCT_SEQUENCE = "product_code"
BILL_SEQUENCE = "bill_number"
BARCODE_SEQUENCE = "barcode"


def _next_value(session: Session, name: str) -> int:
    """Atomically increment and return the next value for a named sequence."""
    # Ensure the row exists.
    seq = session.get(Sequence, name)
    if seq is None:
        seq = Sequence(name=name, current_value=0)
        session.add(seq)
        session.flush()

    # Atomic increment at the SQL level.
    session.execute(
        update(Sequence)
        .where(Sequence.name == name)
        .values(current_value=Sequence.current_value + 1)
    )
    session.flush()
    session.refresh(seq)
    return seq.current_value


def next_product_code(session: Session) -> str:
    value = _next_value(session, PRODUCT_SEQUENCE)
    return f"{settings.PRODUCT_CODE_PREFIX}{value:0{settings.PRODUCT_CODE_PADDING}d}"


def next_bill_number(session: Session) -> str:
    value = _next_value(session, BILL_SEQUENCE)
    return f"{settings.BILL_NUMBER_PREFIX}{value:0{settings.BILL_NUMBER_PADDING}d}"


def next_barcode(session: Session) -> str:
    """Simple sequential barcodes: 1001, 1002, 1003 ...

    Skips any value already present on a product (in case some were entered
    manually) so the generated code is always unique.
    """
    from database.models import Product

    start = getattr(settings, "BARCODE_START", 1000)
    seq = session.get(Sequence, BARCODE_SEQUENCE)
    if seq is None:
        session.add(Sequence(name=BARCODE_SEQUENCE, current_value=start))
        session.flush()
    for _ in range(100000):
        value = _next_value(session, BARCODE_SEQUENCE)
        code = str(value)
        exists = session.query(Product.id).filter(Product.barcode == code).first()
        if not exists:
            return code
    raise RuntimeError("Unable to allocate a unique barcode.")
