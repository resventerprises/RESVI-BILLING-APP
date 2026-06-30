"""
Reusable CRUD base.

A thin, generic data-access layer so each entity's repository is a few lines
instead of repeated boilerplate. Routes/services depend on these repositories,
never on raw session queries, keeping the data layer swappable.
"""
from __future__ import annotations

from typing import Generic, Sequence, TypeVar

from sqlalchemy import select
from sqlalchemy.orm import Session

from database.models import Base

ModelT = TypeVar("ModelT", bound=Base)


class CRUDBase(Generic[ModelT]):
    def __init__(self, model: type[ModelT]):
        self.model = model

    def get(self, session: Session, obj_id) -> ModelT | None:
        return session.get(self.model, obj_id)

    def list(self, session: Session, limit: int | None = None) -> Sequence[ModelT]:
        stmt = select(self.model)
        if limit is not None:
            stmt = stmt.limit(limit)
        return session.scalars(stmt).all()

    def create(self, session: Session, **kwargs) -> ModelT:
        obj = self.model(**kwargs)
        session.add(obj)
        session.flush()  # populate PK without committing the surrounding scope
        return obj

    def update(self, session: Session, obj: ModelT, **kwargs) -> ModelT:
        for key, value in kwargs.items():
            setattr(obj, key, value)
        session.flush()
        return obj

    def delete(self, session: Session, obj: ModelT) -> None:
        session.delete(obj)
        session.flush()
