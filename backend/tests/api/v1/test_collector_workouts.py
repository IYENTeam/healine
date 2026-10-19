"""Synthetic fixtures follow Polar's v4 training-session contract, not v3 exercises."""

from copy import deepcopy
from datetime import date
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import CollectorBatch, EventRecord, User, WorkoutDetails
from app.services.providers.polar.collector import normalize_polar_response
from tests.api.v1.test_collectors import BASE, DAY, connect, delivery, observations


def workout_payload() -> dict[str, Any]:
    return {
        "healineSportCatalog": {"1": {"name": "RUNNING", "label": "달리기", "parentName": "RUNNING"}},
        "trainingSessions": [
            {
                "identifier": {"id": "test-session-1"},
                "modified": "2026-09-17T15:40:00Z",
                "startTime": DAY + "T23:30:00",
                "stopTime": "2026-09-18T00:35:00",
                "timezoneOffsetMinutes": 540,
                "durationMillis": 3600000,
                "name": "Night run",
                "sport": {"id": "1"},
                "distanceMeters": 10000,
                "calories": 600,
                "hrAvg": 150,
                "hrMax": 181,
                "trainingLoadReport": {"cardioLoad": 80, "cardioLoadInterpretation": "LOAD_INTERPRETATION_HIGH"},
                "exercises": [
                    {
                        "identifier": {"id": "test-leg-1"},
                        "sport": {"id": "1"},
                        "durationMillis": 3600000,
                        "statistics": {
                            "statistics": [{"type": "STATISTICS_TYPE_HEART_RATE", "min": 90, "avg": 150, "max": 181}]
                        },
                        "zones": [
                            {
                                "type": "ZONE_TYPE_HEART_RATE",
                                "zones": [{"lowerLimit": 130, "higherLimit": 150, "inZone": 600000}],
                            }
                        ],
                        "samples": {
                            "samples": [
                                {"type": "SAMPLE_TYPE_HEART_RATE", "intervalMillis": 1000, "values": [90, 91, 92]}
                            ]
                        },
                        "laps": {"laps": [{"durationMillis": 300000}], "autoLaps": [{"durationMillis": 310000}]},
                    }
                ],
            }
        ],
    }


def test_workouts_are_raw_retained_canonical_and_idempotent(
    client: TestClient, user: User, auth_headers: dict[str, str], db: Session
) -> None:
    headers = connect(client, user, auth_headers)
    payload = workout_payload()
    for _ in range(2):
        response = client.post(BASE + "/batches", headers=headers, json=delivery("workout", payload))
        assert response.status_code == 200
        assert response.json()["status"] == "processed"
    assert db.scalar(select(func.count()).select_from(EventRecord)) == 1
    assert db.scalar(select(func.count()).select_from(WorkoutDetails)) == 1
    batch = db.scalar(select(CollectorBatch))
    assert batch.payload == payload
    record = db.scalar(select(EventRecord))
    assert record.category == "workout"
    assert record.type == "running"
    assert record.start_datetime.isoformat() == "2026-09-17T14:30:00+00:00"
    assert record.end_datetime.isoformat() == "2026-09-17T15:35:00+00:00"
    assert record.duration_seconds == 3600
    result = observations(client, headers)
    assert result["workoutAccess"] == "granted"
    workout = result["workouts"][0]
    assert workout["elapsedSeconds"] == 3900
    assert workout["exercises"][0]["zones"][0]["durationSeconds"] == 600
    assert workout["exercises"][0]["detailCounts"] == {
        "sampleValues": 3,
        "rrSamples": 0,
        "manualLaps": 1,
        "automaticLaps": 1,
        "strengthRounds": 0,
    }
    # Exercise data must also serialize through the platform's existing workout API.
    api = client.get(
        f"/api/v1/users/{user.id}/events/workouts",
        headers=auth_headers,
        params={"start_date": DAY + "T00:00:00Z", "end_date": "2026-09-19T00:00:00Z", "include": ["zones", "segments"]},
    )
    assert api.status_code == 200, api.text
    shared = api.json()["data"][0]
    assert shared["distance_meters"] == 10000
    assert shared["entry_source"] == "automatic"
    assert shared["hr_zones"]["zones"][0]["seconds"] == 600
    assert shared["segments"][0]["id"] == "test-leg-1"
    changed = deepcopy(payload)
    changed["trainingSessions"][0]["calories"] = 610
    changed["trainingSessions"][0]["stopTime"] = "2026-09-18T00:36:00"
    client.post(BASE + "/batches", headers=headers, json=delivery("workout", changed))
    assert db.scalar(select(func.count()).select_from(EventRecord)) == 1
    assert float(db.scalar(select(WorkoutDetails)).energy_burned) == 610


def test_workout_permission_failure_keeps_existing_data_and_other_resources(
    client: TestClient, user: User, auth_headers: dict[str, str]
) -> None:
    headers = connect(client, user, auth_headers)
    client.post(BASE + "/batches", headers=headers, json=delivery("workout", workout_payload()))
    response = client.post(BASE + "/batches", headers=headers, json=delivery("workout", {}, 403))
    assert response.json()["diagnostics"]["code"] == "workout_access_denied"
    client.post(BASE + "/batches", headers=headers, json=delivery())
    result = observations(client, headers)
    assert result["workoutAccess"] == "needs_connection"
    assert len(result["workouts"]) == 1
    assert len(result["heartRateSamples"]) == 1


def test_workout_normalization_distinguishes_zero_missing_invalid_and_duplicate_sessions() -> None:
    payload = workout_payload()
    session = payload["trainingSessions"][0]
    session["calories"] = 0
    session["distanceMeters"] = None
    session["hrMax"] = 0
    duplicate = deepcopy(session)
    duplicate["modified"] = "2026-09-17T15:41:00Z"
    duplicate["calories"] = 5
    invalid = deepcopy(session)
    invalid["identifier"] = {"id": "missing-timezone"}
    invalid.pop("timezoneOffsetMinutes")
    payload["trainingSessions"] += [duplicate, invalid]
    result, diagnostics = normalize_polar_response("workout", date.fromisoformat(DAY), payload)
    assert len(result["workouts"]) == 1
    assert result["workouts"][0]["energyKcal"] == 5
    assert result["workouts"][0]["distanceMeters"] is None
    assert result["workouts"][0]["heartRateMaxBpm"] is None
    assert diagnostics["rejected_samples"] == 1
    assert diagnostics["code"] == "partial"
    empty, diagnostic = normalize_polar_response("workout", date.fromisoformat(DAY), {"trainingSessions": []})
    assert empty["workouts"] == []
    assert diagnostic["code"] == "no_days"


def test_workout_explicit_offset_and_multisport_legs_are_one_session() -> None:
    payload = workout_payload()
    session = payload["trainingSessions"][0]
    session["startTime"] = DAY + "T23:30:00-04:00"
    session["stopTime"] = "2026-09-18T00:35:00-04:00"
    session.pop("timezoneOffsetMinutes")
    session["exercises"].append(deepcopy(session["exercises"][0]))
    result, _ = normalize_polar_response("workout", date.fromisoformat(DAY), payload)
    assert len(result["workouts"]) == 1
    assert result["workouts"][0]["date"] == "2026-09-18"
    assert result["workouts"][0]["zoneOffset"] == "-04:00"
    assert len(result["workouts"][0]["exercises"]) == 2


def test_workout_utc_timestamp_uses_recorded_offset_for_provider_date() -> None:
    payload = workout_payload()
    session = payload["trainingSessions"][0]
    session["startTime"] = "2026-09-16T23:30:00Z"
    session["stopTime"] = "2026-09-17T00:35:00Z"
    result, _ = normalize_polar_response("workout", date.fromisoformat(DAY), payload)
    assert result["workouts"][0]["date"] == DAY
    assert result["workouts"][0]["zoneOffset"] == "+09:00"
    session["timezoneOffsetMinutes"] = 1000
    result, diagnostics = normalize_polar_response("workout", date.fromisoformat(DAY), payload)
    assert not result["workouts"]
    assert diagnostics["rejected_samples"] == 1
