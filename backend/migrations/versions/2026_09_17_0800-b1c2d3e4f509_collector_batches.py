"""Store scoped collectors and replayable provider responses.

Revision ID: b1c2d3e4f509
Revises: a7c3e9f1b2d4
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "b1c2d3e4f509"
down_revision = "a7c3e9f1b2d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "collector_connection",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("user_id", sa.UUID(), sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("key_hash", sa.String(64), unique=True),
        sa.Column("pairing_hash", sa.String(64), unique=True),
        sa.Column("pairing_expires_at", sa.DateTime(timezone=True)),
        sa.Column("paired_at", sa.DateTime(timezone=True)),
        sa.Column("last_received_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "provider", name="uq_collector_user_provider"),
    )
    op.create_table(
        "collector_batch",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "connection_id", sa.UUID(), sa.ForeignKey("collector_connection.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("http_status", sa.Integer(), nullable=False),
        sa.Column("digest", sa.String(64), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("normalized", postgresql.JSONB(), nullable=False),
        sa.Column("diagnostics", postgresql.JSONB(), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("connection_id", "kind", "date", "digest", name="uq_collector_batch_content"),
    )
    op.create_index("ix_collector_batch_latest", "collector_batch", ["connection_id", "date", "kind", "fetched_at"])


def downgrade() -> None:
    op.drop_table("collector_batch")
    op.drop_table("collector_connection")
