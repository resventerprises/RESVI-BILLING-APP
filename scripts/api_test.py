"""
Full backend flow test via the Flask test client. Run from project root:

    python scripts/api_test.py

Covers: category create -> product create with images (enroll-on-save) ->
listing -> scan a known frame (expect auto_add) -> complete a bill ->
history -> daily sales -> settings info. Uses synthetic images, no real photos.
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np
from PIL import Image


def _img_bytes(seed: int) -> bytes:
    rng = np.random.default_rng(seed)
    arr = rng.integers(seed % 180, (seed % 180) + 50, size=(160, 160, 3), dtype=np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="JPEG")
    return buf.getvalue()


def main() -> int:
    # Fresh DB for a clean assertion run.
    db = ROOT / "resvi.db"
    if db.exists():
        db.unlink()

    from app import create_app

    app = create_app()
    c = app.test_client()

    # 1. category
    r = c.post("/api/categories", json={"name": "Toys & Games"})
    assert r.status_code == 201, r.get_json()
    cat_id = r.get_json()["data"]["id"]
    print("[ok] category created", cat_id)

    # 2. product with 5 images (distinctive seed)
    form = {
        "name": "Wooden Toy Car",
        "category_id": str(cat_id),
        "selling_price": "149",
        "discount": "10",
        "images": [(io.BytesIO(_img_bytes(31)), f"img{i}.jpg") for i in range(5)],
    }
    r = c.post("/api/products", data=form, content_type="multipart/form-data")
    assert r.status_code == 201, ("product create failed", r.status_code, r.get_json())
    pid = r.get_json()["data"]["id"]
    print("[ok] product created", pid, r.get_json()["data"]["product_code"])

    # 3. list
    r = c.get("/api/products")
    assert r.status_code == 200 and len(r.get_json()["data"]) == 1
    print("[ok] product listed")

    # 4. scan a frame identical to enrolled -> auto_add
    r = c.post("/api/scan", data={"frame": (io.BytesIO(_img_bytes(31)), "frame.jpg")},
               content_type="multipart/form-data")
    body = r.get_json()["data"]
    print(f"[..] scan decision={body['decision']} top={body['top'] and body['top']['product_name']}")
    assert body["decision"] == "auto_add", body
    assert body["top"]["product_id"] == pid

    # 5. complete a bill
    r = c.post("/api/bills/complete", json={"items": [{"product_id": pid, "quantity": 3}]})
    assert r.status_code == 201, r.get_json()
    bill = r.get_json()["data"]
    # 3 * (149 - 10) = 417
    assert bill["grand_total"] == 417.0, bill
    print("[ok] bill completed", bill["bill_number"], bill["grand_total"])

    # 6. history + 7. daily + 8. settings
    assert len(c.get("/api/bills").get_json()["data"]) == 1
    daily = c.get("/api/sales/daily").get_json()["data"]
    assert daily and daily[0]["num_bills"] == 1 and daily[0]["net_sales"] == 417.0
    info = c.get("/api/settings/info").get_json()["data"]
    assert info["app"] == "RESVI"
    print("[ok] history, daily sales, settings verified")

    # cleanup — release the SQLite handle first (Windows locks open files).
    from database.db import engine

    engine.dispose()
    try:
        if db.exists():
            db.unlink()
    except PermissionError:
        pass  # harmless: a leftover dev DB, removed on next run
    print("\nALL BACKEND FLOW CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
