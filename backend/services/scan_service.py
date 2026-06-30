"""
Scan service: turns a camera frame into a UI-ready recognition result.

The recognizer returns product ids + scores + a decision; this layer hydrates
those into the names, prices, and image references the scan screen needs, so
the frontend gets everything in one round trip.

It also runs an optional face guard: if OpenCV is installed and a human face
fills a meaningful part of the frame, recognition is skipped and a "face"
decision is returned so the UI can say "Please scan a product" instead of
matching a face to a product.
"""
from __future__ import annotations

import io

import numpy as np
from PIL import Image
from sqlalchemy.orm import Session

from ai.recognizer import AIRecognizer, RecognitionResult
from database.crud import repositories as repo

# Lazily-loaded Haar face cascade (only if opencv is installed).
_FACE = None
_FACE_TRIED = False


def _face_detector():
    global _FACE, _FACE_TRIED
    if _FACE_TRIED:
        return _FACE
    _FACE_TRIED = True
    try:
        import cv2  # optional dependency

        path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        _FACE = cv2.CascadeClassifier(path)
    except Exception:
        _FACE = None
    return _FACE


def _has_face(image: Image.Image) -> bool:
    det = _face_detector()
    if det is None:
        return False
    try:
        import cv2

        arr = np.asarray(image.convert("RGB"))
        gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
        h, w = gray.shape
        faces = det.detectMultiScale(gray, scaleFactor=1.2, minNeighbors=5,
                                     minSize=(int(w * 0.18), int(h * 0.18)))
        return len(faces) > 0
    except Exception:
        return False


def _hydrate(session: Session, product_id: int, score: float) -> dict | None:
    product = repo.products.get(session, product_id)
    if product is None:
        return None
    images = repo.product_images.for_product(session, product_id)
    return {
        "product_id": product.id,
        "product_code": product.product_code,
        "product_name": product.product_name,
        "selling_price": product.selling_price,
        "discount": product.discount,
        "family_key": product.family_key,
        "score": round(score, 4),
        "primary_image_id": images[0].id if images else None,
    }


def scan_frame(
    session: Session, recognizer: AIRecognizer, image_bytes: bytes
) -> dict:
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

    # Reject obvious non-products (faces) before matching.
    if _has_face(image):
        return {
            "decision": "face",
            "variant_disambiguation": False,
            "top": None,
            "candidates": [],
            "message": "Face detected. Please scan a product.",
        }

    result: RecognitionResult = recognizer.identify(image)

    candidates = []
    for cand in result.candidates:
        hydrated = _hydrate(session, cand.product_id, cand.score)
        if hydrated:
            candidates.append(hydrated)

    top = candidates[0] if candidates else None
    return {
        "decision": result.decision.value,
        "variant_disambiguation": result.variant_disambiguation,
        "top": top,
        "candidates": candidates,
    }
