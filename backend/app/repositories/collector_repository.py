from datetime import UTC, date, datetime
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.models import CollectorBatch, CollectorConnection, DataSource, EventRecord, HealthScore, SleepDetails, User
from app.repositories.data_source_repository import DataSourceRepository
from app.schemas.enums import ProviderName


class CollectorRepository:
    def user_exists(self, db: Session, user_id: UUID) -> bool:
        return db.get(User, user_id) is not None

    def connection_for_user(self, db: Session, user_id: UUID) -> CollectorConnection | None:
        return db.scalar(
            select(CollectorConnection).where(
                CollectorConnection.user_id == user_id, CollectorConnection.provider == "polar-v4"
            )
        )

    def connection_for_key(self, db: Session, key_hash: str) -> CollectorConnection | None:
        return db.scalar(select(CollectorConnection).where(CollectorConnection.key_hash == key_hash))

    def connection_for_pairing(self, db: Session, pairing_hash: str) -> CollectorConnection | None:
        return db.scalar(
            select(CollectorConnection).where(CollectorConnection.pairing_hash == pairing_hash).with_for_update()
        )

    def save_connection(self, db: Session, connection: CollectorConnection) -> CollectorConnection:
        db.add(connection)
        db.commit()
        db.refresh(connection)
        return connection

    def lock_connection(self, db: Session, connection_id: UUID) -> CollectorConnection:
        return db.execute(
            select(CollectorConnection).where(CollectorConnection.id == connection_id).with_for_update()
        ).scalar_one()

    def accept(self, db: Session, batch: CollectorBatch) -> CollectorBatch:
        self.lock_connection(db, batch.connection_id).last_received_at = datetime.now(UTC)
        values = {
            column.name: getattr(batch, column.name)
            for column in CollectorBatch.__table__.columns
            if column.name != "created_at"
        }
        statement = insert(CollectorBatch).values(**values)
        statement = statement.on_conflict_do_update(
            constraint="uq_collector_batch_content",
            set_={
                "received_at": batch.received_at,
                "fetched_at": func.greatest(CollectorBatch.fetched_at, batch.fetched_at),
            },
        ).returning(CollectorBatch.id)
        batch_id = db.execute(statement).scalar_one()
        # Raw input must survive a crash or normalization error.
        db.commit()
        return db.execute(select(CollectorBatch).where(CollectorBatch.id == batch_id)).scalar_one()

    def data_source(self, db: Session, user_id: UUID) -> DataSource:
        identity = (user_id, None, "polar_accesslink_v4")
        identifiers = DataSourceRepository().batch_ensure_data_sources(db, ProviderName.POLAR, None, {identity})
        return db.execute(select(DataSource).where(DataSource.id == identifiers[identity])).scalar_one()

    def save_sleep(self, db: Session, record: EventRecord, detail: SleepDetails) -> EventRecord:
        existing = db.scalar(
            select(EventRecord).where(
                EventRecord.data_source_id == record.data_source_id, EventRecord.external_id == record.external_id
            )
        )
        if existing:
            existing.start_datetime = record.start_datetime
            existing.end_datetime = record.end_datetime
            existing.duration_seconds = record.duration_seconds
            existing_detail = db.get(SleepDetails, existing.id)
            if existing_detail:
                existing_detail.sleep_time_in_bed_minutes = detail.sleep_time_in_bed_minutes
            else:
                detail.record_id = existing.id
                db.add(detail)
            return existing
        db.add(record)
        db.flush()
        db.add(detail)
        return record

    def save_score(self, db: Session, score: HealthScore) -> None:
        filters = [
            HealthScore.user_id == score.user_id,
            HealthScore.provider == score.provider,
            HealthScore.category == score.category,
        ]
        if score.event_record_id:
            filters.append(HealthScore.event_record_id == score.event_record_id)
        else:
            filters.extend([HealthScore.recorded_at == score.recorded_at, HealthScore.event_record_id.is_(None)])
        existing = db.scalar(select(HealthScore).where(*filters))
        if existing:
            existing.value = score.value
            existing.recorded_at = score.recorded_at
            existing.components = score.components
            existing.data_source_id = score.data_source_id
        else:
            db.add(score)

    def batch(self, db: Session, batch_id: UUID, *, refresh: bool = False) -> CollectorBatch | None:
        return db.get(CollectorBatch, batch_id, populate_existing=refresh)

    def latest(self, db: Session, batch: CollectorBatch) -> CollectorBatch:
        return db.execute(
            select(CollectorBatch)
            .where(
                CollectorBatch.connection_id == batch.connection_id,
                CollectorBatch.kind == batch.kind,
                CollectorBatch.date == batch.date,
            )
            .order_by(CollectorBatch.fetched_at.desc(), CollectorBatch.received_at.desc())
            .limit(1)
        ).scalar_one()

    def save_batch(self, db: Session, batch: CollectorBatch) -> CollectorBatch:
        db.add(batch)
        db.commit()
        db.refresh(batch)
        return batch

    def rollback(self, db: Session) -> None:
        db.rollback()

    def recent(self, db: Session, connection_id: UUID, limit: int = 100) -> list[CollectorBatch]:
        return list(
            db.scalars(
                select(CollectorBatch)
                .where(CollectorBatch.connection_id == connection_id)
                .order_by(CollectorBatch.fetched_at.desc(), CollectorBatch.received_at.desc())
                .limit(limit)
            )
        )

    def observations(
        self, db: Session, connection_id: UUID, start: date, end: date, *, successful: bool
    ) -> list[CollectorBatch]:
        statement = select(CollectorBatch).where(
            CollectorBatch.connection_id == connection_id,
            CollectorBatch.date >= start,
            CollectorBatch.date < end,
        )
        if successful:
            statement = statement.where(CollectorBatch.status == "processed")
        statement = statement.distinct(CollectorBatch.date, CollectorBatch.kind).order_by(
            CollectorBatch.date,
            CollectorBatch.kind,
            CollectorBatch.fetched_at.desc(),
            CollectorBatch.received_at.desc(),
        )
        return list(db.scalars(statement))

    def pending(self, db: Session, limit: int = 20) -> list[UUID]:
        return list(
            db.scalars(
                select(CollectorBatch.id)
                .where(CollectorBatch.status.in_(["pending", "processing_error"]), CollectorBatch.attempts < 5)
                .order_by(CollectorBatch.received_at)
                .limit(limit)
            )
        )


collector_repository = CollectorRepository()
