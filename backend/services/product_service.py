"""
Product business logic, including the AI side effects.

Saving a product enrolls its images (no training step). Toggling status or
deleting keeps the recognition index honest:
  * inactive  -> remove the product's vectors from the index (must not surface
                 in recognition or search, per Part 2)
  * active    -> re-enroll its vectors
  * delete    -> remove image files, DB rows (cascade), and vectors
"""
from __future__ import annotations

import shutil
from pathlib import Path

from sqlalchemy.orm import Session

from ai.enrollment import enroll_image
from ai.recognizer import AIRecognizer
from backend.services.code_generator import next_barcode, next_product_code
from config import settings
from database.crud import repositories as repo
from database.models import Product, ProductImage, Status
from utils.validators import (
    ValidationError,
    require_non_empty,
    require_positive_number,
    validate_min_images,
)


def _product_dir(product_id: int) -> Path:
    path = settings.UPLOAD_DIR / str(product_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def create_product(
    session: Session,
    recognizer: AIRecognizer,
    *,
    name: str,
    category_id: int,
    selling_price,
    discount=0.0,
    cost_price=0.0,
    quantity=0,
    min_stock_level=0,
    description: str | None = None,
    barcode: str | None = None,
    family_key: str | None = None,
    image_sources: list[tuple[str, bytes]] | None = None,
) -> Product:
    """image_sources: list of (filename, raw_bytes).

    In the barcode workflow images are optional (one confirmation photo is
    recommended but not required). If any images are supplied they are enrolled
    for the Experimental AI recognizer, but they are no longer mandatory.
    """
    name = require_non_empty(name, "Product name")
    selling_price = require_positive_number(selling_price, "Selling price")
    discount = require_positive_number(discount, "Discount")
    cost_price = require_positive_number(cost_price or 0, "Cost price")
    try:
        quantity = max(0, int(quantity or 0))
        min_stock_level = max(0, int(min_stock_level or 0))
    except (TypeError, ValueError):
        raise ValidationError("Quantity and minimum stock must be whole numbers.")
    if repo.categories.get(session, category_id) is None:
        raise ValidationError("Category not found.")

    # Barcode: use the provided one (must be unique) or auto-generate.
    barcode = (barcode or "").strip()
    if barcode:
        clash = session.query(Product.id).filter(Product.barcode == barcode).first()
        if clash:
            raise ValidationError(f"Barcode {barcode} is already assigned to another product.")
    else:
        barcode = next_barcode(session)

    image_sources = image_sources or []

    product = repo.products.create(
        session,
        product_code=next_product_code(session),
        barcode=barcode,
        product_name=name,
        category_id=category_id,
        selling_price=selling_price,
        discount=discount,
        cost_price=cost_price,
        quantity=0,
        min_stock_level=min_stock_level,
        description=(description or None),
        family_key=(family_key.strip() or None) if family_key else None,
        status=Status.ACTIVE,
    )

    # Record opening stock as a movement so inventory history is complete.
    if quantity > 0:
        from backend.services import inventory_service
        inventory_service.stock_in(session, product.id, quantity, remarks="Opening stock")

    target_dir = _product_dir(product.id)
    for filename, raw in image_sources:
        ext = Path(filename).suffix.lower() or ".jpg"
        dest = target_dir / f"{product.id}_{len(repo.product_images.for_product(session, product.id))}{ext}"
        dest.write_bytes(raw)
        image = repo.product_images.create(
            session, product_id=product.id, image_path=str(dest), image_type="enroll"
        )
        enroll_image(session, recognizer, product, image)  # embeds + indexes

    return product


def update_product(
    session: Session, recognizer: AIRecognizer, product_id: int, **fields
) -> Product:
    product = repo.products.get(session, product_id)
    if product is None:
        raise ValidationError("Product not found.")

    if "product_name" in fields:
        fields["product_name"] = require_non_empty(fields["product_name"], "Product name")
    if "selling_price" in fields:
        fields["selling_price"] = require_positive_number(fields["selling_price"], "Selling price")
    if "discount" in fields:
        fields["discount"] = require_positive_number(fields["discount"], "Discount")
    if "cost_price" in fields:
        fields["cost_price"] = require_positive_number(fields["cost_price"], "Cost price")
    if "min_stock_level" in fields:
        try:
            fields["min_stock_level"] = max(0, int(fields["min_stock_level"]))
        except (TypeError, ValueError):
            raise ValidationError("Minimum stock must be a whole number.")
    if "description" in fields:
        fields["description"] = (fields["description"] or None)
    if "barcode" in fields:
        bc = (fields["barcode"] or "").strip()
        if bc:
            clash = (
                session.query(Product.id)
                .filter(Product.barcode == bc, Product.id != product_id)
                .first()
            )
            if clash:
                raise ValidationError(f"Barcode {bc} is already assigned to another product.")
            fields["barcode"] = bc
        else:
            fields["barcode"] = None
    # Quantity: record the change as a stock adjustment so inventory history
    # stays accurate (rather than a raw overwrite).
    new_qty = fields.pop("quantity", None)
    qty_delta = None
    if new_qty is not None and str(new_qty) != "":
        try:
            target = int(new_qty)
        except (TypeError, ValueError):
            raise ValidationError("Quantity must be a whole number.")
        if target < 0:
            raise ValidationError("Quantity cannot be negative.")
        qty_delta = target - (product.quantity or 0)
    if "family_key" in fields:
        fk = fields["family_key"]
        fields["family_key"] = (fk.strip() or None) if fk else None

    status_change = None
    if "status" in fields:
        new_status = fields["status"]
        if isinstance(new_status, str):
            new_status = Status(new_status)
        fields["status"] = new_status
        status_change = new_status

    product = repo.products.update(session, product, **fields)

    # Apply any quantity change through the inventory module for history.
    if qty_delta:
        from backend.services import inventory_service
        inventory_service.adjust(session, product.id, qty_delta, remarks="Manual edit")

    # Keep the index consistent with status.
    if status_change is Status.INACTIVE:
        recognizer.remove_product(product.id)
    elif status_change is Status.ACTIVE:
        recognizer.remove_product(product.id)  # avoid duplicates
        for image in repo.product_images.for_product(session, product.id):
            enroll_image(session, recognizer, product, image)
    return product


def delete_product(session: Session, recognizer: AIRecognizer, product_id: int) -> None:
    product = repo.products.get(session, product_id)
    if product is None:
        raise ValidationError("Product not found.")
    recognizer.remove_product(product.id)
    # Remove image files on disk; DB rows (images, embeddings) cascade.
    target_dir = settings.UPLOAD_DIR / str(product.id)
    if target_dir.exists():
        shutil.rmtree(target_dir, ignore_errors=True)
    repo.products.delete(session, product)


def search_products(session: Session, **kwargs):
    return repo.products.search(session, **kwargs)


def serialize(product: Product, session: Session) -> dict:
    images = repo.product_images.for_product(session, product.id)
    category = repo.categories.get(session, product.category_id)
    from backend.services import inventory_service
    return {
        "id": product.id,
        "product_code": product.product_code,
        "barcode": product.barcode,
        "product_name": product.product_name,
        "category_id": product.category_id,
        "category_name": category.category_name if category else None,
        "selling_price": product.selling_price,
        "discount": product.discount,
        "cost_price": product.cost_price or 0,
        "quantity": product.quantity or 0,
        "min_stock_level": product.min_stock_level or 0,
        "description": product.description,
        "stock_status": inventory_service.stock_status(product),
        "status": product.status.value,
        "family_key": product.family_key,
        "image_count": len(images),
        "primary_image_id": images[0].id if images else None,
        "image": f"/api/products/image/{images[0].id}" if images else None,
    }
