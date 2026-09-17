import hashlib
import json
import secrets
from datetime import UTC, date, datetime, timedelta
from logging import getLogger
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.config import settings
from app.models import CollectorBatch, CollectorConnection, EventRecord, HealthScore, SleepDetails
from app.repositories.collector_repository import collector_repository as repository
from app.schemas.collector import CollectorDelivery, CollectorPaired, CollectorPairingCreated, CollectorStatus
from app.schemas.enums import HealthScoreCategory, ProviderName, SeriesType
from app.schemas.model_crud.activities import TimeSeriesSampleCreate
from app.services.providers.polar.collector import (
    OBSERVATION_KEYS,
    SEOUL,
    CollectorSchemaError,
    empty_observations,
    normalize_polar_response,
)
from app.services.timeseries_service import timeseries_service
from app.utils.security import hash_api_key
from app.utils.sentry_helpers import log_and_capture_error

logger = getLogger(__name__)


class CollectorService:
    def pair_request(self, db: Session, user_id: UUID) -> CollectorPairingCreated:
        if not repository.user_exists(db, user_id):
            raise HTTPException(404, "User not found")
        code = secrets.token_urlsafe(32)
        expires = datetime.now(UTC) + timedelta(minutes=15)
        connection = repository.connection_for_user(db, user_id) or CollectorConnection(
            id=uuid4(), user_id=user_id, provider="polar-v4", key_hash=None, paired_at=None, last_received_at=None
        )
        connection.pairing_hash = hash_api_key(code)
        connection.pairing_expires_at = expires
        repository.save_connection(db, connection)
        return CollectorPairingCreated(code=code, expires_at=expires, connection_id=connection.id)

    def pair(self, db: Session, code: str) -> CollectorPaired:
        connection = repository.connection_for_pairing(db, hash_api_key(code))
        if not connection or not connection.pairing_expires_at or connection.pairing_expires_at <= datetime.now(UTC):
            raise HTTPException(401, "Pairing code is invalid or expired")
        key = secrets.token_urlsafe(48)
        connection.key_hash = hash_api_key(key)
        connection.pairing_hash = None
        connection.pairing_expires_at = None
        connection.paired_at = datetime.now(UTC)
        repository.save_connection(db, connection)
        return CollectorPaired(connection_id=connection.id, key=key)

    def authenticate(self, db: Session, key: str | None) -> CollectorConnection:
        connection = repository.connection_for_key(db, hash_api_key(key)) if key else None
        if not connection:
            raise HTTPException(401, "Invalid collector credential")
        return connection

    def ingest(self, db: Session, connection: CollectorConnection, delivery: CollectorDelivery) -> CollectorBatch:
        digest = hashlib.sha256(
            json.dumps(
                [delivery.http_status, delivery.payload], sort_keys=True, separators=(",", ":"), allow_nan=False
            ).encode()
        ).hexdigest()
        batch = repository.accept(
            db,
            CollectorBatch(
                id=uuid4(),
                connection_id=connection.id,
                kind=delivery.kind,
                date=delivery.date,
                fetched_at=delivery.fetched_at,
                received_at=datetime.now(UTC),
                http_status=delivery.http_status,
                digest=digest,
                payload=delivery.payload,
                normalized={},
                diagnostics={},
                status="pending",
                attempts=0,
                processed_at=None,
            ),
        )
        return self.process(db, batch.id)

    def process(self, db: Session, batch_id: UUID) -> CollectorBatch:
        batch = repository.batch(db, batch_id)
        if not batch:
            raise HTTPException(404, "Batch not found")
        connection = repository.lock_connection(db, batch.connection_id)
        # Another worker may have processed this delivery while we waited for the lock.
        batch = repository.batch(db, batch_id, refresh=True)
        assert batch is not None
        if repository.latest(db, batch).id != batch.id:
            # A prior successful snapshot remains the fallback when a later fetch is empty.
            if batch.status != "processed":
                batch.status = "superseded"
            return repository.save_batch(db, batch)
        batch.attempts += 1
        processing_started = datetime.now(UTC)
        connection_id = batch.connection_id
        batch.processed_at = processing_started
        if batch.http_status != 200:
            batch.normalized = {}
            batch.status = "provider_error"
            batch.diagnostics = {"code": "http_error", "http_status": batch.http_status}
            return repository.save_batch(db, batch)
        try:
            normalized, diagnostics = normalize_polar_response(batch.kind, batch.date, batch.payload)
            batch.normalized = normalized
            batch.diagnostics = diagnostics
            batch.status = (
                "processed"
                if any(normalized.values())
                else ("parse_error" if diagnostics["code"] == "invalid_samples" else "empty")
            )
            self._save_observations(db, connection, normalized)
            return repository.save_batch(db, batch)
        except CollectorSchemaError as error:
            batch.status = "parse_error"
            batch.normalized = {}
            batch.diagnostics = {
                "code": "unexpected_schema",
                "detail": str(error),
                "response_keys": sorted(batch.payload),
            }
            return repository.save_batch(db, batch)
        except Exception as error:
            repository.rollback(db)
            log_and_capture_error(error, logger, "Collector processing failed", extra={"batch_id": str(batch_id)})
            repository.lock_connection(db, connection_id)
            batch = repository.batch(db, batch_id, refresh=True)
            assert batch is not None
            if batch.processed_at and batch.processed_at >= processing_started:
                return repository.save_batch(db, batch)
            batch.status = "processing_error"
            batch.attempts += 1
            batch.processed_at = processing_started
            batch.diagnostics = {"code": "processing_error", "error_type": type(error).__name__}
            return repository.save_batch(db, batch)

    def _save_observations(self, db: Session, connection: CollectorConnection, data: dict[str, Any]) -> None:
        samples = []
        for key, value_key, series_type in (
            ("heartRateSamples", "heartRate", SeriesType.heart_rate),
            ("stepSamples", "steps", SeriesType.steps),
            ("metSamples", "met", SeriesType.average_met),
        ):
            for sample in data[key]:
                samples.append(
                    TimeSeriesSampleCreate(
                        id=uuid4(),
                        user_id=connection.user_id,
                        provider="polar",
                        source="polar_accesslink_v4",
                        recorded_at=datetime.fromtimestamp(sample["timestampMs"] / 1000, UTC),
                        zone_offset="+09:00",
                        value=sample[value_key],
                        series_type=series_type,
                        is_daily_total=False,
                    )
                )
        timeseries_service.bulk_create_samples(db, samples)
        source = repository.data_source(db, connection.user_id)
        for sleep in data["sleeps"]:
            start = datetime.fromtimestamp(sleep["startMs"] / 1000, UTC)
            end = datetime.fromtimestamp(sleep["endMs"] / 1000, UTC)
            record = EventRecord(
                id=uuid4(),
                data_source_id=source.id,
                source_name="Polar AccessLink v4",
                category="sleep",
                type="sleep_session",
                start_datetime=start,
                end_datetime=end,
                duration_seconds=int((end - start).total_seconds()),
                zone_offset="+09:00",
                external_id="polar-v4-sleep-" + sleep["date"],
            )
            detail = SleepDetails(record_id=record.id, sleep_time_in_bed_minutes=sleep["durationMinutes"])
            saved = repository.save_sleep(db, record, detail)
            if sleep["score"] is not None:
                repository.save_score(
                    db,
                    HealthScore(
                        id=uuid4(),
                        user_id=connection.user_id,
                        data_source_id=source.id,
                        provider=ProviderName.POLAR,
                        category=HealthScoreCategory.SLEEP,
                        value=sleep["score"],
                        recorded_at=start,
                        zone_offset="+09:00",
                        event_record_id=saved.id,
                    ),
                )
        for night in data["nightlyRecharges"]:
            value = night.get("recoveryIndicator")
            if isinstance(value, (int, float)) and not isinstance(value, bool) and 1 <= value <= 6:
                components = {}
                for key in (
                    "meanNightlyRecoveryRmssd",
                    "meanNightlyRecoveryRri",
                    "meanBaselineRmssd",
                    "meanBaselineRri",
                ):
                    metric = night.get(key)
                    if isinstance(metric, (int, float)) and not isinstance(metric, bool) and metric > 0:
                        components[key] = {"value": metric}
                repository.save_score(
                    db,
                    HealthScore(
                        id=uuid4(),
                        user_id=connection.user_id,
                        data_source_id=source.id,
                        provider=ProviderName.POLAR,
                        category=HealthScoreCategory.RECOVERY,
                        value=value,
                        recorded_at=datetime.fromisoformat(night["sleepResultDate"]).replace(tzinfo=SEOUL),
                        zone_offset="+09:00",
                        components=components or None,
                    ),
                )

    def status(self, db: Session, user_id: UUID) -> CollectorStatus:
        connection = repository.connection_for_user(db, user_id)
        return CollectorStatus(
            public_url=settings.collector_public_url,
            setup_url=settings.collector_setup_url,
            connection_id=connection.id if connection else None,
            paired_at=connection.paired_at if connection else None,
            last_received_at=connection.last_received_at if connection else None,
            batches=repository.recent(db, connection.id) if connection else [],
        )

    def observations(self, db: Session, connection: CollectorConnection, start: date, end: date) -> dict[str, Any]:
        if not 0 < (end - start).days <= 15:
            raise HTTPException(422, "Request between 1 and 15 days; end date is exclusive")
        result = empty_observations()
        for batch in repository.observations(db, connection.id, start, end, successful=True):
            for key in OBSERVATION_KEYS:
                result[key].extend(batch.normalized.get(key, []))
        latest = repository.observations(db, connection.id, start, end, successful=False)
        result["diagnostics"] = [
            {
                "date": b.date.isoformat(),
                "kind": b.kind,
                "status": b.status,
                "fetchedAt": b.fetched_at.isoformat(),
                **b.diagnostics,
            }
            for b in latest
        ]
        sleep_batches = [b for b in latest if b.kind == "sleep"]
        result["sleepAccess"] = (
            "needs_connection"
            if any(b.http_status == 403 for b in sleep_batches)
            else "error"
            if any(b.http_status != 200 for b in sleep_batches)
            else "granted"
        )
        result["source"] = "healine-platform"
        return result

    def replay(self, db: Session, user_id: UUID, batch_id: UUID) -> CollectorBatch:
        connection = repository.connection_for_user(db, user_id)
        batch = repository.batch(db, batch_id)
        if not connection or not batch or batch.connection_id != connection.id:
            raise HTTPException(404, "Batch not found")
        return self.process(db, batch_id)


collector_service = CollectorService()
