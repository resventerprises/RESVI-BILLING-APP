"""Category business logic."""
from __future__ import annotations

from sqlalchemy.orm import Session

from database.crud import repositories as repo
from database.models import Category, Status
from utils.validators import ValidationError, require_non_empty


def create_category(session: Session, name: str, icon: str | None = None) -> Category:
    name = require_non_empty(name, "Category name")
    if repo.categories.by_name(session, name):
        raise ValidationError(f"Category '{name}' already exists.")
    return repo.categories.create(
        session, category_name=name, category_icon=icon, status=Status.ACTIVE
    )


def update_category(session: Session, category_id: int, **fields) -> Category:
    category = repo.categories.get(session, category_id)
    if category is None:
        raise ValidationError("Category not found.")
    if "category_name" in fields:
        fields["category_name"] = require_non_empty(fields["category_name"], "Category name")
    if "status" in fields and isinstance(fields["status"], str):
        fields["status"] = Status(fields["status"])
    return repo.categories.update(session, category, **fields)


def delete_category(session: Session, category_id: int) -> None:
    category = repo.categories.get(session, category_id)
    if category is None:
        raise ValidationError("Category not found.")
    if category.products:
        raise ValidationError(
            "Cannot delete a category that still has products. Move or delete them first."
        )
    repo.categories.delete(session, category)


def list_categories(session: Session, only_active: bool = False):
    if only_active:
        return repo.categories.active(session)
    return repo.categories.list(session)
