from datetime import date
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query

from app.database import DbSession
from app.models import CollectorConnection
from app.schemas.collector import (
    CollectorBatchRead,
    CollectorDelivery,
    CollectorPaired,
    CollectorPairing,
    CollectorPairingCreated,
    CollectorStatus,
)
from app.services import ApiKeyDep
from app.services.collector_service import collector_service

router = APIRouter()


def _collector(db: DbSession, x_healine_collector_key: str | None = Header(None)) -> CollectorConnection:
    return collector_service.authenticate(db, x_healine_collector_key)


CollectorDep = Annotated[CollectorConnection, Depends(_collector)]


@router.post("/users/{user_id}/collectors/polar-v4/pair")
async def create_pairing(user_id: UUID, db: DbSession, _auth: ApiKeyDep) -> CollectorPairingCreated:
    return collector_service.pair_request(db, user_id)


@router.post("/collectors/pair")
async def consume_pairing(payload: CollectorPairing, db: DbSession) -> CollectorPaired:
    return collector_service.pair(db, payload.code)


@router.post("/collectors/batches", response_model=CollectorBatchRead)
async def ingest_batch(payload: CollectorDelivery, db: DbSession, collector: CollectorDep) -> Any:
    return collector_service.ingest(db, collector, payload)


@router.get("/collectors/observations")
async def get_observations(
    db: DbSession,
    collector: CollectorDep,
    start: Annotated[date, Query(alias="from")],
    end: Annotated[date, Query(alias="to")],
) -> dict[str, Any]:
    return collector_service.observations(db, collector, start, end)


@router.get("/users/{user_id}/collectors/polar-v4")
async def get_collector_status(user_id: UUID, db: DbSession, _auth: ApiKeyDep) -> CollectorStatus:
    return collector_service.status(db, user_id)


@router.post("/users/{user_id}/collectors/batches/{batch_id}/replay", response_model=CollectorBatchRead)
async def replay_batch(user_id: UUID, batch_id: UUID, db: DbSession, _auth: ApiKeyDep) -> Any:
    return collector_service.replay(db, user_id, batch_id)
