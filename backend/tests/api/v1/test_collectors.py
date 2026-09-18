from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import CollectorBatch, CollectorConnection, DataPointSeries, EventRecord, HealthScore, User
from app.services.collector_service import collector_service
from app.services.providers.polar.collector import CollectorSchemaError
from tests.factories import UserFactory

BASE = "/api/v1/collectors"
DAY = "2026-09-17"


def connect(client: TestClient, user: User, auth: dict[str, str]) -> dict[str, str]:
    response = client.post(f"/api/v1/users/{user.id}/collectors/polar-v4/pair", headers=auth)
    assert response.status_code == 200
    paired = client.post(BASE + "/pair", json={"code": response.json()["code"]})
    assert paired.status_code == 200
    return {"X-Healine-Collector-Key": paired.json()["key"]}


def delivery(kind: str = "heart_rate", payload: dict | None = None, http_status: int = 200) -> dict:
    return {
        "kind": kind,
        "date": DAY,
        "fetched_at": datetime.now(UTC).isoformat(),
        "http_status": http_status,
        "payload": payload
        if payload is not None
        else {
            "continuousSamples": {
                "heartRateSamplesPerDay": [{"date": DAY, "samples": [{"heartRate": 72, "offsetMillis": 36_000_000}]}]
            }
        },
    }


def observations(client: TestClient, headers: dict[str, str]) -> dict:
    response = client.get(BASE + "/observations", headers=headers, params={"from": DAY, "to": "2026-09-18"})
    assert response.status_code == 200
    return response.json()


def test_pairing_requires_admin_and_is_single_use(
    client: TestClient, user: User, auth_headers: dict[str, str], db: Session
) -> None:
    path = f"/api/v1/users/{user.id}/collectors/polar-v4/pair"
    assert client.post(path).status_code == 401
    code = client.post(path, headers=auth_headers).json()["code"]
    assert client.post(BASE + "/pair", json={"code": code}).status_code == 200
    assert client.post(BASE + "/pair", json={"code": code}).status_code == 401
    connection = db.scalar(select(CollectorConnection))
    assert connection.pairing_hash is None
    assert connection.key_hash
    assert len(connection.key_hash) == 64


def test_expired_pairing_is_rejected(client: TestClient, user: User, auth_headers: dict[str, str], db: Session) -> None:
    code = client.post(f"/api/v1/users/{user.id}/collectors/polar-v4/pair", headers=auth_headers).json()["code"]
    connection = db.scalar(select(CollectorConnection))
    connection.pairing_expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()
    assert client.post(BASE + "/pair", json={"code": code}).status_code == 401


def test_ingestion_persists_raw_and_shared_samples_idempotently(
    client: TestClient, user: User, auth_headers: dict[str, str], db: Session
) -> None:
    headers = connect(client, user, auth_headers)
    payload = delivery()
    first = client.post(BASE + "/batches", headers=headers, json=payload)
    assert first.status_code == 200
    assert first.json()["status"] == "processed"
    again = client.post(BASE + "/batches", headers=headers, json=payload)
    assert again.json()["id"] == first.json()["id"]
    assert db.scalar(select(func.count()).select_from(CollectorBatch)) == 1
    assert db.scalar(select(func.count()).select_from(DataPointSeries)) == 1
    assert db.scalar(select(CollectorBatch)).payload == payload["payload"]
    assert db.scalar(select(DataPointSeries)).recorded_at == datetime(2026, 9, 17, 1, tzinfo=UTC)
    assert observations(client, headers)["heartRateSamples"][0]["heartRate"] == 72


def test_collector_cannot_choose_another_user_or_call_admin_routes(
    client: TestClient, user: User, auth_headers: dict[str, str]
) -> None:
    headers = connect(client, user, auth_headers)
    other = UserFactory()
    other_headers = connect(client, other, auth_headers)
    assert client.post(BASE + "/batches", headers=headers, json=delivery()).status_code == 200
    assert observations(client, other_headers)["heartRateSamples"] == []
    assert client.get("/api/v1/users", headers=headers).status_code == 401
    assert (
        client.post(BASE + "/batches", headers=headers, json={**delivery(), "user_id": str(other.id)}).status_code
        == 400
    )
    assert client.post(BASE + "/batches", json=delivery()).status_code == 401


def test_missing_activity_and_invalid_structure_are_distinguishable(
    client: TestClient, user: User, auth_headers: dict[str, str]
) -> None:
    headers = connect(client, user, auth_headers)
    for raw, expected in [
        ({}, "no_days"),
        ({"activities": {"activityDays": [{"date": DAY}]}}, "no_samples"),
        ({"unexpected": []}, "unexpected_schema"),
        ({"activities": {"unexpected": []}}, "unexpected_schema"),
    ]:
        response = client.post(BASE + "/batches", headers=headers, json=delivery("activity", raw))
        assert response.json()["diagnostics"]["code"] == expected
    assert observations(client, headers)["stepSamples"] == []
    denied = client.post(BASE + "/batches", headers=headers, json=delivery("activity", {}, 403))
    assert denied.json()["status"] == "provider_error"
    assert denied.json()["diagnostics"]["http_status"] == 403


def test_activity_preserves_real_zero_and_accepts_time_with_offset(
    client: TestClient, user: User, auth_headers: dict[str, str]
) -> None:
    headers = connect(client, user, auth_headers)
    device = {
        "activitySamples": [
            {
                "stepSamples": {"startTime": "10:00:00+09:00", "interval": "60000", "steps": [0, 3, None]},
                "metSamples": {"startTime": "10:00:00", "interval": "60000", "mets": [1.125, 2.0, 0]},
            }
        ]
    }
    body = {"activities": {"activityDays": [{"date": DAY, "activitiesPerDevice": [device, device]}]}}
    response = client.post(BASE + "/batches", headers=headers, json=delivery("activity", body))
    assert response.json()["status"] == "processed"
    result = observations(client, headers)
    assert [s["steps"] for s in result["stepSamples"]] == [0, 3]
    assert [s["met"] for s in result["metSamples"]] == [1.125, 2.0]


def test_out_of_order_delivery_and_replay_do_not_replace_newer_data(
    client: TestClient, user: User, auth_headers: dict[str, str], db: Session
) -> None:
    headers = connect(client, user, auth_headers)
    old = delivery()
    old["fetched_at"] = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    newer = delivery()
    newer["payload"]["continuousSamples"]["heartRateSamplesPerDay"][0]["samples"][0]["heartRate"] = 88
    client.post(BASE + "/batches", headers=headers, json=newer)
    late = client.post(BASE + "/batches", headers=headers, json=old).json()
    assert late["status"] == "superseded"
    replayed = client.post(f"/api/v1/users/{user.id}/collectors/batches/{late['id']}/replay", headers=auth_headers)
    assert replayed.json()["status"] == "superseded"
    assert float(db.scalar(select(DataPointSeries)).value) == 88


def test_empty_or_failed_response_retains_previous_observations_with_diagnostic(
    client: TestClient, user: User, auth_headers: dict[str, str]
) -> None:
    headers = connect(client, user, auth_headers)
    client.post(BASE + "/batches", headers=headers, json=delivery())
    client.post(BASE + "/batches", headers=headers, json=delivery(payload={}))
    result = observations(client, headers)
    assert result["heartRateSamples"][0]["heartRate"] == 72
    assert result["diagnostics"][0]["code"] == "no_days"
    client.post(BASE + "/batches", headers=headers, json=delivery(payload={}, http_status=500))
    assert observations(client, headers)["diagnostics"][0]["code"] == "http_error"


def test_replaying_cached_success_after_empty_fetch_preserves_observations(
    client: TestClient, user: User, auth_headers: dict[str, str]
) -> None:
    headers = connect(client, user, auth_headers)
    first = client.post(BASE + "/batches", headers=headers, json=delivery()).json()
    client.post(BASE + "/batches", headers=headers, json=delivery(payload={}))
    replay = client.post(f"/api/v1/users/{user.id}/collectors/batches/{first['id']}/replay", headers=auth_headers)
    assert replay.json()["status"] == "processed"
    assert observations(client, headers)["heartRateSamples"][0]["heartRate"] == 72
    assert observations(client, headers)["diagnostics"][0]["code"] == "no_days"


def test_processing_failure_keeps_raw_for_successful_replay(
    client: TestClient, user: User, auth_headers: dict[str, str], db: Session
) -> None:
    headers = connect(client, user, auth_headers)
    with patch.object(collector_service, "_save_observations", side_effect=RuntimeError("test failure")):
        response = client.post(BASE + "/batches", headers=headers, json=delivery()).json()
    assert response["status"] == "processing_error"
    assert db.scalar(select(func.count()).select_from(DataPointSeries)) == 0
    assert db.scalar(select(CollectorBatch)).payload == delivery()["payload"]
    replay = client.post(f"/api/v1/users/{user.id}/collectors/batches/{response['id']}/replay", headers=auth_headers)
    assert replay.json()["status"] == "processed"
    assert db.scalar(select(func.count()).select_from(DataPointSeries)) == 1


def test_sleep_correction_updates_existing_event_and_score(
    client: TestClient, user: User, auth_headers: dict[str, str], db: Session
) -> None:
    headers = connect(client, user, auth_headers)
    body = {
        "nightSleeps": [
            {
                "sleepDate": DAY,
                "sleepResult": {
                    "hypnogram": {"sleepStart": "2026-09-16T23:00:00+09:00", "sleepEnd": "2026-09-17T07:00:00+09:00"}
                },
                "sleepScore": {"sleepScore": 72},
            }
        ]
    }
    for _ in range(2):
        assert (
            client.post(BASE + "/batches", headers=headers, json=delivery("sleep", body)).json()["status"]
            == "processed"
        )
    body["nightSleeps"][0]["sleepResult"]["hypnogram"]["sleepEnd"] = "2026-09-17T07:15:00+09:00"
    body["nightSleeps"][0]["sleepScore"]["sleepScore"] = 74
    assert client.post(BASE + "/batches", headers=headers, json=delivery("sleep", body)).json()["status"] == "processed"
    assert db.scalar(select(func.count()).select_from(EventRecord)) == 1
    assert db.scalar(select(func.count()).select_from(HealthScore)) == 1
    assert float(db.scalar(select(HealthScore)).value) == 74
    assert db.scalar(select(EventRecord)).duration_seconds == 8 * 3600 + 15 * 60


def test_invalid_recovery_does_not_claim_success(
    client: TestClient, user: User, auth_headers: dict[str, str], db: Session
) -> None:
    headers = connect(client, user, auth_headers)
    raw = {"nightlyRechargeResults": [{"sleepResultDate": DAY, "recoveryIndicator": "invalid"}]}
    response = client.post(BASE + "/batches", headers=headers, json=delivery("recovery", raw))
    assert response.json()["status"] == "parse_error"
    assert response.json()["diagnostics"]["code"] == "invalid_samples"
    assert observations(client, headers)["nightlyRecharges"] == []
    assert db.scalar(select(func.count()).select_from(HealthScore)) == 0


def test_recovery_components_and_sleep_errors_remain_distinct(
    client: TestClient, user: User, auth_headers: dict[str, str], db: Session
) -> None:
    headers = connect(client, user, auth_headers)
    raw = {
        "nightlyRechargeResults": [
            {
                "sleepResultDate": DAY,
                "recoveryIndicator": 3,
                "meanNightlyRecoveryRmssd": 40,
                "meanNightlyRecoveryRri": 935,
            }
        ]
    }
    response = client.post(BASE + "/batches", headers=headers, json=delivery("recovery", raw))
    assert response.json()["status"] == "processed"
    assert float(db.scalar(select(HealthScore)).value) == 3
    assert observations(client, headers)["nightlyRecharges"][0]["meanNightlyRecoveryRmssd"] == 40
    client.post(BASE + "/batches", headers=headers, json=delivery("sleep", {}, 500))
    assert observations(client, headers)["sleepAccess"] == "error"
    client.post(BASE + "/batches", headers=headers, json=delivery("sleep", {}, 403))
    assert observations(client, headers)["sleepAccess"] == "needs_connection"


def test_live_unwrapped_daily_shapes_can_be_replayed_into_shared_records(
    client: TestClient, user: User, auth_headers: dict[str, str], db: Session
) -> None:
    headers = connect(client, user, auth_headers)
    raw_hr = delivery()["payload"]["continuousSamples"]
    raw_activity = {
        "activityDays": [
            {
                "date": DAY,
                "activitiesPerDevice": [
                    {
                        "activitySamples": [
                            {
                                "stepSamples": {"startTime": "10:00:00+09:00", "interval": "60000", "steps": [0, 3]},
                                "metSamples": {
                                    "startTime": "10:00:00+09:00",
                                    "interval": "60000",
                                    "mets": [1.125, 2.0],
                                },
                            }
                        ]
                    }
                ],
            }
        ]
    }
    batch_ids = []
    with patch(
        "app.services.collector_service.normalize_polar_response",
        side_effect=CollectorSchemaError("Missing wrapper"),
    ):
        for kind, raw in [("heart_rate", raw_hr), ("activity", raw_activity)]:
            response = client.post(BASE + "/batches", headers=headers, json=delivery(kind, raw))
            assert response.json()["status"] == "parse_error"
            batch_ids.append(response.json()["id"])
    assert db.scalar(select(func.count()).select_from(DataPointSeries)) == 0
    # The repaired parser must create missing shared records, then replay idempotently.
    for _ in range(2):
        for batch_id in batch_ids:
            replay = client.post(f"/api/v1/users/{user.id}/collectors/batches/{batch_id}/replay", headers=auth_headers)
            assert replay.json()["status"] == "processed"
    result = observations(client, headers)
    assert result["heartRateSamples"][0]["heartRate"] == 72
    assert [s["steps"] for s in result["stepSamples"]] == [0, 3]
    assert [s["met"] for s in result["metSamples"]] == [1.125, 2.0]
    assert db.scalar(select(func.count()).select_from(DataPointSeries)) == 5
    saved = db.scalar(select(CollectorBatch).where(CollectorBatch.kind == "heart_rate"))
    assert saved is not None
    assert saved.payload == raw_hr
    # Recognize a data envelope without losing the original response.
    wrapped = client.post(BASE + "/batches", headers=headers, json=delivery("activity", {"data": raw_activity}))
    assert wrapped.json()["status"] == "processed"
    # When both forms are present, the named wrapper takes precedence in Python and Apps Script.
    mixed = client.post(
        BASE + "/batches", headers=headers, json=delivery("activity", {"activities": raw_activity, "activityDays": []})
    )
    assert mixed.json()["status"] == "processed"
    assert (
        client.post(BASE + "/batches", headers=headers, json=delivery("activity", {"activityDays": []})).json()[
            "status"
        ]
        == "empty"
    )
    assert (
        client.post(
            BASE + "/batches", headers=headers, json=delivery("heart_rate", {"heartRateSamplesPerDay": {}})
        ).json()["status"]
        == "parse_error"
    )
