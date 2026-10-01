from datetime import date, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import BaseDbModel
from app.mappings import FKUser, PrimaryKey


class CollectorConnection(BaseDbModel):
    """A scoped edge collector. Provider OAuth credentials stay at the edge."""

    __tablename__ = "collector_connection"
    __table_args__ = (UniqueConstraint("user_id", "provider", name="uq_collector_user_provider"),)

    id: Mapped[PrimaryKey[UUID]]
    user_id: Mapped[FKUser]
    provider: Mapped[str] = mapped_column(String(32))
    key_hash: Mapped[str | None] = mapped_column(String(64), unique=True)
    pairing_hash: Mapped[str | None] = mapped_column(String(64), unique=True)
    pairing_expires_at: Mapped[datetime | None]
    paired_at: Mapped[datetime | None]
    last_received_at: Mapped[datetime | None]


class CollectorBatch(BaseDbModel):
    """Durable provider responses, including empty/error responses, for diagnosis and replay."""

    __tablename__ = "collector_batch"
    __table_args__ = (
        UniqueConstraint("connection_id", "kind", "date", "digest", name="uq_collector_batch_content"),
        Index("ix_collector_batch_latest", "connection_id", "date", "kind", "fetched_at"),
    )

    id: Mapped[PrimaryKey[UUID]]
    connection_id: Mapped[UUID] = mapped_column(ForeignKey("collector_connection.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(32))
    date: Mapped[date]
    fetched_at: Mapped[datetime]
    received_at: Mapped[datetime]
    http_status: Mapped[int]
    digest: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    normalized: Mapped[dict[str, Any]] = mapped_column(JSONB)
    diagnostics: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(32))
    attempts: Mapped[int]
    processed_at: Mapped[datetime | None]
