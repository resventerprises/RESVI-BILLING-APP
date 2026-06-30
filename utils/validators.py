"""
Input validation helpers, isolated from routes so the same rules apply
to the web API now and the Android sync endpoints later.
"""
from __future__ import annotations

from pathlib import Path

from config import settings


class ValidationError(ValueError):
    """Raised when caller-supplied data fails a business rule."""


def require_non_empty(value: str | None, field: str) -> str:
    if value is None or not value.strip():
        raise ValidationError(f"{field} is required.")
    return value.strip()


def require_positive_number(value, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{field} must be a number.")
    if number < 0:
        raise ValidationError(f"{field} cannot be negative.")
    return number


def validate_image_extension(filename: str) -> None:
    ext = Path(filename).suffix.lower()
    if ext not in settings.ALLOWED_IMAGE_EXTENSIONS:
        allowed = ", ".join(sorted(settings.ALLOWED_IMAGE_EXTENSIONS))
        raise ValidationError(f"Unsupported image type '{ext}'. Allowed: {allowed}.")


def validate_min_images(count: int) -> None:
    if count < settings.MIN_PRODUCT_IMAGES:
        raise ValidationError(
            f"At least {settings.MIN_PRODUCT_IMAGES} images are required "
            f"(received {count})."
        )
