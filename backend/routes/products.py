"""Product endpoints: CRUD, search, status toggle, and image serving."""
from __future__ import annotations
import io

from flask import Blueprint, current_app, request, send_file

from backend.services import product_service
from database.crud import repositories as repo
from database.db import session_scope
from utils.responses import error, ok
from utils.validators import ValidationError

products_bp = Blueprint("products", __name__, url_prefix="/api/products")


def _recognizer():
    return current_app.config["RECOGNIZER"]


@products_bp.get("")
def list_products():
    term = request.args.get("q")
    category_id = request.args.get("category_id", type=int)
    only_active = request.args.get("active") == "1"
    with session_scope() as s:
        items = product_service.search_products(
            s, term=term, category_id=category_id, only_active=only_active
        )
        return ok([product_service.serialize(p, s) for p in items])


@products_bp.post("")
def create_product():
    """Multipart form: name, category_id, selling_price, discount, family_key,
    and one or more 'images' file parts (>= MIN_PRODUCT_IMAGES)."""
    form = request.form
    files = request.files.getlist("images")
    image_sources = [(f.filename, f.read()) for f in files if f and f.filename]
    try:
        with session_scope() as s:
            product = product_service.create_product(
                s,
                _recognizer(),
                name=form.get("name"),
                category_id=form.get("category_id", type=int),
                selling_price=form.get("selling_price"),
                discount=form.get("discount", 0.0),
                cost_price=form.get("cost_price", 0.0),
                quantity=form.get("quantity", 0),
                min_stock_level=form.get("min_stock_level", 0),
                description=form.get("description"),
                barcode=form.get("barcode"),
                family_key=form.get("family_key"),
                image_sources=image_sources,
            )
            return ok(product_service.serialize(product, s), status=201)
    except ValidationError as exc:
        return error("validation_error", str(exc))


@products_bp.get("/import/template")
def import_template():
    """Download a ready-to-fill products.xlsx with the correct header row."""
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "products"
    ws.append(["product_name", "category", "price", "quantity", "barcode", "min_stock", "image_name"])
    ws.append(["UNO RED BOX", "TOYS", 120, 20, "1001", 5, "UNO_RED_BOX.jpeg"])
    ws.append(["UNO FLIP BOX", "TOYS", 120, 15, "1002", 5, "uno_flip_box.jpg"])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return send_file(
        buf,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name="products_template.xlsx",
    )


@products_bp.post("/import")
def import_products_route():
    """Multipart: 'xlsx' or 'file' (.xlsx/.csv, required) + optional 'images' zip."""
    from backend.services import import_service

    upload = request.files.get("xlsx") or request.files.get("file")
    if not upload or not upload.filename:
        return error("validation_error", "Please attach a products .xlsx or .csv file.")
    zip_file = request.files.get("images")
    file_bytes = upload.read()
    zip_bytes = zip_file.read() if zip_file and zip_file.filename else None
    try:
        with session_scope() as s:
            result = import_service.import_products(
                s, _recognizer(), file_bytes, zip_bytes, filename=upload.filename
            )
        if result["errors"]:
            return error("import_error", result["errors"][0])
        return ok(result)
    except Exception as exc:  # noqa: BLE001
        current_app.logger.exception("Bulk import failed")
        return error("import_error", f"{type(exc).__name__}: {exc}", status=500)


@products_bp.post("/deduplicate")
def deduplicate_route():
    """Merge duplicate products that share the same name (case-insensitive).

    Keeps the oldest record of each name, moves its stock to the survivor, and
    removes the extras. Fixes catalogues polluted by earlier repeated imports.
    """
    from collections import defaultdict
    from database.models import Product

    removed = 0
    kept = 0
    try:
        with session_scope() as s:
            groups = defaultdict(list)
            for p in s.query(Product).order_by(Product.id).all():
                groups[(p.product_name or "").strip().lower()].append(p)
            for name, plist in groups.items():
                if len(plist) < 2:
                    kept += 1
                    continue
                survivor = plist[0]
                for dup in plist[1:]:
                    # Keep the larger stock so we don't lose inventory.
                    if (dup.quantity or 0) > (survivor.quantity or 0):
                        survivor.quantity = dup.quantity
                    if not survivor.barcode and dup.barcode:
                        survivor.barcode = dup.barcode
                    s.delete(dup)
                    removed += 1
                kept += 1
        return ok({"removed": removed, "unique_products": kept})
    except Exception as exc:  # noqa: BLE001
        current_app.logger.exception("Deduplicate failed")
        return error("dedup_error", f"{type(exc).__name__}: {exc}", status=500)


@products_bp.get("/next-barcode")
def next_barcode_route():
    """Preview the next auto-generated barcode (does not consume it)."""
    from database.models import Product
    from config import settings as _settings

    with session_scope() as s:
        start = getattr(_settings, "BARCODE_START", 1000)
        existing = {row[0] for row in s.query(Product.barcode).filter(Product.barcode.isnot(None)).all()}
        n = start + 1
        while str(n) in existing:
            n += 1
        return ok({"barcode": str(n)})


@products_bp.get("/by-barcode/<barcode>")
def get_by_barcode(barcode: str):
    """Primary billing lookup: resolve a scanned/typed barcode to a product."""
    from database.models import Product, Status

    with session_scope() as s:
        product = (
            s.query(Product)
            .filter(Product.barcode == barcode.strip(), Product.status == Status.ACTIVE)
            .first()
        )
        if product is None:
            return error("not_found", "Product not found for this barcode.", status=404)
        return ok(product_service.serialize(product, s))


@products_bp.get("/<int:product_id>/label")
def product_label(product_id: int):
    """Printable Code128 label PDF for one product. ?copies=N for an A4 sheet."""
    from flask import request as _rq, send_file
    from database.models import Product
    from backend.services import label_service

    copies = _rq.args.get("copies", type=int) or 1
    with session_scope() as s:
        p = s.get(Product, product_id)
        if p is None or not p.barcode:
            return error("not_found", "Product or barcode not found.", status=404)
        name, price, barcode = p.product_name, f"Rs.{p.selling_price:.2f}", p.barcode
    if copies <= 1:
        pdf = label_service.single_label_pdf(name, price, barcode)
        fname = f"label_{barcode}.pdf"
    else:
        pdf = label_service.sheet_pdf([{"name": name, "price": price, "barcode": barcode}] * copies)
        fname = f"labels_{barcode}_x{copies}.pdf"
    return send_file(io.BytesIO(pdf), mimetype="application/pdf",
                     as_attachment=True, download_name=fname)


@products_bp.put("/<int:product_id>")
def update_product(product_id: int):
    body = request.get_json(silent=True) or {}
    try:
        with session_scope() as s:
            product = product_service.update_product(s, _recognizer(), product_id, **body)
            return ok(product_service.serialize(product, s))
    except ValidationError as exc:
        return error("validation_error", str(exc))


@products_bp.delete("/<int:product_id>")
def delete_product(product_id: int):
    try:
        with session_scope() as s:
            product_service.delete_product(s, _recognizer(), product_id)
            return ok({"deleted": product_id})
    except ValidationError as exc:
        return error("validation_error", str(exc))


@products_bp.get("/image/<int:image_id>")
def product_image(image_id: int):
    with session_scope() as s:
        image = repo.product_images.get(s, image_id)
        if image is None:
            return error("not_found", "Image not found.", status=404)
        path = image.image_path
    return send_file(path)
