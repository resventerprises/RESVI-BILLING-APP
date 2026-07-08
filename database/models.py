"""
ORM models for RESVI.

Schema follows Part 3 of the master prompt, with two deliberate additions:

  * Sequences      - a monotonic counter table so product codes and bill
                     numbers are never reused after deletion (a MAX(id)+1
                     scheme would reuse numbers, which Part 3 forbids).
  * ProductEmbeddings - persisted vectors keyed to (product_id, model_id).
                     SQLite is the source of truth; the in-memory/FAISS index
                     is rebuilt from these rows on startup. Storing model_id
                     lets us re-enroll under a new model without dropping the
                     old vectors until the swap is verified.

The 'family_key' on Product is the size/variant-disambiguation seam: products
that are the same item in different sizes share a family_key, so the recognizer
can force a variant popup instead of guessing size from a single frame.
"""
from __future__ import annotations

import enum
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Status(str, enum.Enum):
    ACTIVE = "active"
    INACTIVE = "inactive"


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utcnow, onupdate=_utcnow, nullable=False
    )


class Sequence(Base):
    """Named monotonic counters. Drives product codes and bill numbers."""

    __tablename__ = "sequences"

    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    current_value: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class Category(Base, TimestampMixin):
    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    category_name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    category_icon: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[Status] = mapped_column(Enum(Status), default=Status.ACTIVE, nullable=False)

    products: Mapped[list["Product"]] = relationship(back_populates="category")


class Product(Base, TimestampMixin):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_code: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)
    barcode: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True, index=True)
    product_name: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"), nullable=False)
    selling_price: Mapped[float] = mapped_column(Float, nullable=False)
    discount: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    # Inventory
    cost_price: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    min_stock_level: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[Status] = mapped_column(
        Enum(Status), default=Status.ACTIVE, nullable=False, index=True
    )
    # Items that are the same product in different sizes share a family_key.
    # NULL => standalone product. Used to force variant disambiguation.
    family_key: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    # Which bulk import created/last-touched this product (for Import History).
    import_batch_id: Mapped[int | None] = mapped_column(
        ForeignKey("import_batches.id"), nullable=True, index=True
    )

    category: Mapped["Category"] = relationship(back_populates="products")
    images: Mapped[list["ProductImage"]] = relationship(
        back_populates="product", cascade="all, delete-orphan"
    )
    embeddings: Mapped[list["ProductEmbedding"]] = relationship(
        back_populates="product", cascade="all, delete-orphan"
    )


class ProductImage(Base):
    __tablename__ = "product_images"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id: Mapped[int] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    image_path: Mapped[str] = mapped_column(String(512), nullable=False)
    image_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, nullable=False)

    product: Mapped["Product"] = relationship(back_populates="images")


class ImportBatch(Base):
    """One row per bulk Excel/CSV import, for the Import History screen."""

    __tablename__ = "import_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    updated_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="active", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, nullable=False, index=True)


class ProductEmbedding(Base):
    """One row per enrolled image vector. The recognition index is derived
    from these rows, so the DB remains the single source of truth."""

    __tablename__ = "product_embeddings"
    __table_args__ = (UniqueConstraint("image_id", "model_id", name="uq_image_model"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id: Mapped[int] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    image_id: Mapped[int] = mapped_column(
        ForeignKey("product_images.id", ondelete="CASCADE"), nullable=False
    )
    model_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    dim: Mapped[int] = mapped_column(Integer, nullable=False)
    # Vector stored as JSON-encoded float list. Portable across SQLite/Postgres;
    # swap to pgvector when migrating without changing the read/write API.
    vector: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, nullable=False)

    product: Mapped["Product"] = relationship(back_populates="embeddings")


class Bill(Base):
    __tablename__ = "bills"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    bill_number: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)
    bill_date: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, nullable=False, index=True)
    total_items: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    subtotal: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    total_discount: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    discount_type: Mapped[str | None] = mapped_column(String(12), nullable=True)  # 'percent'|'fixed'
    discount_value: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    grand_total: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    payment_method: Mapped[str] = mapped_column(String(16), default="cash", nullable=False)
    payment_breakdown: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON for SPLIT

    items: Mapped[list["BillItem"]] = relationship(
        back_populates="bill", cascade="all, delete-orphan"
    )


class BillItem(Base):
    __tablename__ = "bill_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    bill_id: Mapped[int] = mapped_column(
        ForeignKey("bills.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), nullable=True)
    item_name: Mapped[str | None] = mapped_column(String(200), nullable=True)  # manual items
    quantity: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    unit_price: Mapped[float] = mapped_column(Float, nullable=False)
    discount: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    total_price: Mapped[float] = mapped_column(Float, nullable=False)

    bill: Mapped["Bill"] = relationship(back_populates="items")


class DailySale(Base):
    """Pre-aggregated daily summary, keyed by ISO date string (YYYY-MM-DD)."""

    __tablename__ = "daily_sales"

    sale_date: Mapped[str] = mapped_column(String(10), primary_key=True)
    num_bills: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_sales: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    total_discount: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    net_sales: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)


class CashDrawer(Base):
    """One row per business day (IST date), tracking the physical cash drawer.

    Cash SALES are never stored here — they are computed live from bills (cash +
    the cash portion of split payments), so they can't drift. Only the manually
    entered figures live here.
    """

    __tablename__ = "cash_drawer"

    drawer_date: Mapped[str] = mapped_column(String(10), primary_key=True)  # YYYY-MM-DD (IST)
    opening_cash: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    cash_expenses: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    actual_cash: Mapped[float | None] = mapped_column(Float, nullable=True)   # counted at close
    closing_cash: Mapped[float | None] = mapped_column(Float, nullable=True)  # carried to next day
    opened: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    closed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, nullable=False)


class StockMovement(Base):
    """Every change to a product's quantity: stock-in, sale-out, adjustment."""

    __tablename__ = "stock_movements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id: Mapped[int] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    movement_type: Mapped[str] = mapped_column(String(16), nullable=False)  # in | out | adjust
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)  # signed (+in / -out)
    balance_after: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    reference: Mapped[str | None] = mapped_column(String(64), nullable=True)  # e.g. bill number
    remarks: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, nullable=False, index=True)
