"""
Concrete repositories. Each is a thin specialization of CRUDBase plus the
few entity-specific queries the services need. Services depend on these,
never on raw session queries.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from database.crud.base import CRUDBase
from database.models import (
    Bill,
    BillItem,
    Category,
    DailySale,
    Product,
    ProductImage,
    Status,
)


class CategoryRepository(CRUDBase[Category]):
    def __init__(self):
        super().__init__(Category)

    def by_name(self, session: Session, name: str) -> Category | None:
        return session.scalar(select(Category).where(Category.category_name == name))

    def active(self, session: Session):
        return session.scalars(
            select(Category).where(Category.status == Status.ACTIVE).order_by(Category.category_name)
        ).all()


class ProductRepository(CRUDBase[Product]):
    def __init__(self):
        super().__init__(Product)

    def by_code(self, session: Session, code: str) -> Product | None:
        return session.scalar(select(Product).where(Product.product_code == code))

    def search(
        self,
        session: Session,
        term: str | None = None,
        category_id: int | None = None,
        only_active: bool = False,
        limit: int | None = None,
        offset: int = 0,
    ):
        stmt = select(Product)
        if only_active:
            stmt = stmt.where(Product.status == Status.ACTIVE)
        if category_id is not None:
            stmt = stmt.where(Product.category_id == category_id)
        if term:
            like = f"%{term.strip()}%"
            stmt = stmt.where(
                (Product.product_name.ilike(like))
                | (Product.product_code.ilike(like))
                | (Product.barcode.ilike(like))
            )
        stmt = stmt.order_by(Product.product_name)
        if offset:
            stmt = stmt.offset(offset)
        if limit is not None:
            stmt = stmt.limit(limit)
        return session.scalars(stmt).all()

    def search_count(
        self,
        session: Session,
        term: str | None = None,
        category_id: int | None = None,
        only_active: bool = False,
    ) -> int:
        from sqlalchemy import func
        stmt = select(func.count(Product.id))
        if only_active:
            stmt = stmt.where(Product.status == Status.ACTIVE)
        if category_id is not None:
            stmt = stmt.where(Product.category_id == category_id)
        if term:
            like = f"%{term.strip()}%"
            stmt = stmt.where(
                (Product.product_name.ilike(like))
                | (Product.product_code.ilike(like))
                | (Product.barcode.ilike(like))
            )
        return session.scalar(stmt) or 0


class ProductImageRepository(CRUDBase[ProductImage]):
    def __init__(self):
        super().__init__(ProductImage)

    def for_product(self, session: Session, product_id: int):
        return session.scalars(
            select(ProductImage).where(ProductImage.product_id == product_id)
        ).all()


class BillRepository(CRUDBase[Bill]):
    def __init__(self):
        super().__init__(Bill)

    def by_number(self, session: Session, number: str) -> Bill | None:
        return session.scalar(select(Bill).where(Bill.bill_number == number))

    def recent(self, session: Session, limit: int = 50):
        return session.scalars(
            select(Bill).order_by(Bill.bill_date.desc()).limit(limit)
        ).all()


class DailySaleRepository(CRUDBase[DailySale]):
    def __init__(self):
        super().__init__(DailySale)

    def recent(self, session: Session, limit: int = 30):
        return session.scalars(
            select(DailySale).order_by(DailySale.sale_date.desc()).limit(limit)
        ).all()


# Shared singletons (stateless).
categories = CategoryRepository()
products = ProductRepository()
product_images = ProductImageRepository()
bills = BillRepository()
daily_sales = DailySaleRepository()
