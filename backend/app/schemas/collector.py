import json
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

CollectorKind = Literal["heart_rate", "activity", "sleep", "recovery"]


class CollectorDelivery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: CollectorKind
    date: date
    fetched_at: AwareDatetime
    http_status: int = Field(ge=100, le=599)
    payload: dict[str, Any]

    @model_validator(mode="after")
    def validate_delivery(self) -> "CollectorDelivery":
        if self.fetched_at > datetime.now(UTC) + timedelta(minutes=5):
            raise ValueError("fetched_at cannot be in the future")
        if len(json.dumps(self.payload, allow_nan=False).encode()) > 10 * 1024 * 1024:
            raise ValueError("Provider response exceeds 10 MiB")
        return self


class CollectorPairing(BaseModel):
    code: str = Field(min_length=32, max_length=256)


class CollectorPairingCreated(BaseModel):
    code: str
    expires_at: datetime
    connection_id: UUID


class CollectorPaired(BaseModel):
    connection_id: UUID
    key: str


class CollectorBatchRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    kind: str
    date: date
    fetched_at: datetime
    received_at: datetime
    http_status: int
    status: str
    attempts: int
    diagnostics: dict[str, Any]


class CollectorStatus(BaseModel):
    public_url: str | None
    setup_url: str | None
    connection_id: UUID | None
    paired_at: datetime | None
    last_received_at: datetime | None
    batches: list[CollectorBatchRead]
