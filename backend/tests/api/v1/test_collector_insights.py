"""Synthetic fixtures follow the AccessLink v4 contract for tests, skin contact, temperature and PPI."""

from datetime import UTC, date, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import DataPointSeries, User
from app.schemas.enums import SeriesType
from app.schemas.enums.series_types import get_series_type_id
from app.services.providers.polar.collector import normalize_polar_response
from tests.api.v1.test_collector_workouts import workout_payload
from tests.api.v1.test_collectors import BASE, DAY, connect

TODAY = date.fromisoformat(DAY)


def post(client: TestClient, headers: dict[str, str], kind: str, day: date, payload: dict[str, Any]) -> dict:
    response = client.post(
        BASE + "/batches",
        headers=headers,
        json={
            "kind": kind,
            "date": day.isoformat(),
            "fetched_at": datetime.now(UTC).isoformat(),
            "http_status": 200,
            "payload": payload,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def read(client: TestClient, headers: dict[str, str], start: date, end: date) -> dict:
    response = client.get(
        BASE + "/observations", headers=headers, params={"from": start.isoformat(), "to": end.isoformat()}
    )
    assert response.status_code == 200, response.text
    return response.json()


def sleep_payload(day: date) -> dict:
    return {
        "nightSleeps": [
            {
                "sleepDate": day.isoformat(),
                "sleepResult": {
                    "hypnogram": {
                        "sleepStart": f"{(day - timedelta(days=1)).isoformat()}T23:30:00+09:00",
                        "sleepEnd": f"{day.isoformat()}T07:00:00+09:00",
                    }
                },
            }
        ]
    }


def recovery_payload(day: date, rmssd: float, rri: float) -> dict:
    return {
        "nightlyRechargeResults": [
            {
                "sleepResultDate": day.isoformat(),
                "recoveryIndicator": 4,
                "ansRate": 3,
                "meanNightlyRecoveryRmssd": rmssd,
                "meanNightlyRecoveryRri": rri,
            }
        ]
    }


def test_workout_night_response_load_and_nightly_hrv_storage(
    client: TestClient, user: User, auth_headers: dict[str, str], db: Session
) -> None:
    headers = connect(client, user, auth_headers)
    # Evening workout on DAY; eight earlier nights form the personal reference.
    workout = workout_payload()
    session = workout["trainingSessions"][0]
    session["startTime"], session["stopTime"] = DAY + "T19:00:00", DAY + "T20:05:00"
    for offset in range(-7, 2):
        night = TODAY + timedelta(days=offset)
        post(client, headers, "sleep", night, sleep_payload(night))
        after = night == TODAY + timedelta(days=1)
        post(client, headers, "recovery", night, recovery_payload(night, 30 if after else 40, 937.5 if after else 1000))
    for offset in range(-6, 0):
        post(client, headers, "workout", TODAY + timedelta(days=offset), {"trainingSessions": []})
    post(client, headers, "workout", TODAY, workout)

    result = read(client, headers, TODAY, TODAY + timedelta(days=1))
    response = result["workoutResponses"]["test-session-1"]
    assert response["night"] == "2026-09-18"
    assert response["matchedBy"] == "sleep_record"
    assert response["comparison"]["referenceNights"] == 8
    assert response["comparison"]["rmssdChangePercent"] == -25.0
    assert response["comparison"]["heartRateChangeBpm"] == 4.0
    training = result["training"][0]
    assert training["workoutCollectionCoveredDays7"] == 7
    assert training["cardioLoad7"] == 80
    # Seven answered days cannot stand for a 28-day average.
    assert training["cardioLoad28WeeklyAverage"] is None
    assert training["acuteToWeeklyAverageRatio"] is None
    assert training["heartRateZones7"] == [{"lowerBpm": 130, "upperBpm": 150, "seconds": 600}]
    assert result["access"]["workout"] == "granted"
    assert result["access"]["ppi"] == "unknown"

    # Nightly RMSSD is stored once inside the matching sleep for shared HRV scores.
    rmssd_type = get_series_type_id(SeriesType.heart_rate_variability_rmssd)
    stored = db.scalars(select(DataPointSeries).where(DataPointSeries.series_type_definition_id == rmssd_type)).all()
    assert len(stored) == 9
    after_workout = [p for p in stored if float(p.value) == 30]
    assert after_workout[0].recorded_at == datetime(2026, 9, 17, 17, 0, tzinfo=UTC)


def test_skin_temperature_deviation_uses_samples_inside_recorded_sleep(
    client: TestClient, user: User, auth_headers: dict[str, str]
) -> None:
    headers = connect(client, user, auth_headers)
    for offset in range(-5, 1):
        night = TODAY + timedelta(days=offset)
        post(client, headers, "sleep", night, sleep_payload(night))
        celsius = 34.0 if offset == 0 else 33.5
        post(
            client,
            headers,
            "temperature",
            night,
            {
                "temperatureMeasurementPeriod": [
                    {
                        "startTime": f"{(night - timedelta(days=1)).isoformat()}T23:00:00",
                        "stopTime": f"{night.isoformat()}T08:00:00",
                        "measurementType": "TM_SKIN_TEMPERATURE",
                        "sensorLocation": "SL_DISTAL",
                        # Samples every 30 min from 23:00; the first precedes the 23:30 sleep onset.
                        "temperatureMeasurementSamples": [
                            {
                                "recordingTimeDeltaMilliseconds": str(i * 1_800_000),
                                "temperatureCelsius": 40.0 if i == 0 else celsius,
                            }
                            for i in range(13)
                        ],
                    }
                ]
            },
        )
    result = read(client, headers, TODAY, TODAY + timedelta(days=1))
    night = result["temperatureNights"][0]
    assert night["status"] == "measured"
    assert night["samples"] == 12
    assert night["referenceNights"] == 5
    assert night["deviationCelsius"] == 0.5


def test_checkins_are_validated_and_removed_notes_do_not_fall_back(
    client: TestClient, user: User, auth_headers: dict[str, str]
) -> None:
    headers = connect(client, user, auth_headers)
    batch = post(
        client,
        headers,
        "checkin",
        TODAY,
        {
            "checkins": [
                {"type": "workout_rpe", "workoutId": "test-session-1", "value": 7},
                {"type": "day_condition", "value": 3},
                {"type": "day_condition", "value": 9},
                {"type": "unknown", "value": 1},
            ]
        },
    )
    assert batch["diagnostics"]["rejected_samples"] == 2
    result = read(client, headers, TODAY, TODAY + timedelta(days=1))
    assert sorted((c["type"], c["value"]) for c in result["checkins"]) == [("day_condition", 3), ("workout_rpe", 7)]
    post(client, headers, "checkin", TODAY, {"checkins": []})
    assert read(client, headers, TODAY, TODAY + timedelta(days=1))["checkins"] == []


def test_tests_and_skin_contact_normalization() -> None:
    tests, _ = normalize_polar_response(
        "test",
        TODAY,
        {
            "data": {
                "tests": [
                    {
                        "created": "2026-09-16T22:05:00Z",
                        "modified": "2026-09-16T22:05:00Z",
                        "startTime": DAY + "T07:00:00",
                        "orthostaticTestResult": {"rrAvgSupine": 1000, "rmssdSupine": 45, "lastResetDate": DAY},
                    },
                    {"startTime": DAY + "T08:00:00", "fitnessTestResult": {"ownIndex": 48, "fitnessClass": "GOOD"}},
                    {"startTime": DAY + "T09:00:00"},
                ]
            }
        },
    )
    assert [t["type"] for t in tests["tests"]] == ["orthostatic", "fitness"]
    assert tests["tests"][0]["values"]["rmssdSupine"] == 45
    assert tests["tests"][0]["values"]["rrAvgStand"] is None
    assert tests["tests"][1]["labels"] == {"fitnessClass": "GOOD"}

    contacts, _ = normalize_polar_response(
        "skin_contact",
        TODAY,
        {
            "skinContactPeriods": [
                {
                    "startTime": DAY + "T22:00:00",
                    "stopTime": "2026-09-18T02:00:00",
                    "skinContactChanges": [
                        {"recordingTimeDeltaMilliseconds": "0", "skinContact": True},
                        {"recordingTimeDeltaMilliseconds": "3600000", "skinContact": False},
                        {"recordingTimeDeltaMilliseconds": "7200000", "skinContact": True},
                    ],
                }
            ]
        },
    )
    hour = 3_600_000
    start = int(datetime.fromisoformat(DAY + "T22:00:00+09:00").timestamp() * 1000)
    # The part after midnight belongs to the next date's request.
    assert contacts["skinContacts"] == [
        {"startMs": start, "endMs": start + hour, "contact": True},
        {"startMs": start + hour, "endMs": start + 2 * hour, "contact": False},
    ]


def test_ppi_quarters_use_clean_successive_beats_only() -> None:
    offsets, intervals, flags = [], [], []
    offset = 36_000_000
    for index in range(41):
        interval = 1000 if index % 2 == 0 else 1010
        offset += interval
        offsets.append(offset)
        intervals.append(interval)
        flags.append(1)
    flags[20] = 3  # Movement breaks the beat chain on both sides.
    columns = {
        "healinePpiColumns": {
            "days": [
                {
                    "date": DAY,
                    "devices": [
                        {
                            "offsetMillis": offsets,
                            "ppInterval": intervals,
                            "errorEstimateMillis": [5] * 41,
                            "flags": flags,
                        }
                    ],
                }
            ]
        }
    }
    result, diagnostics = normalize_polar_response("ppi", TODAY, columns)
    quarter = result["ppiQuarters"][0]
    assert quarter["samples"] == 41
    assert quarter["validIntervals"] == 40
    assert quarter["pairs"] == 38
    assert quarter["rmssdMs"] == 10.0
    assert diagnostics["code"] == "ok"
    original = {
        "dailyPpiSamples": [
            {
                "date": DAY,
                "ppiSamplesPerDevice": [
                    {
                        "ppiSamples": [
                            {
                                "offsetMillis": offsets[i],
                                "ppInterval": intervals[i],
                                "errorEstimateMillis": 5,
                                "skinContact": True,
                                "movement": flags[i] == 3,
                                "offline": False,
                            }
                            for i in range(41)
                        ]
                    }
                ],
            }
        ]
    }
    assert normalize_polar_response("ppi", TODAY, original)[0] == result


def test_missing_sport_catalog_is_reported_as_unknown_not_other() -> None:
    payload = workout_payload()
    payload.pop("healineSportCatalog")
    payload["trainingSessions"][0]["sport"] = {"id": "15"}
    payload["trainingSessions"][0]["exercises"][0]["sport"] = {"id": "15"}
    payload["trainingSessions"][0]["name"] = None
    workout = normalize_polar_response("workout", TODAY, payload)[0]["workouts"][0]
    assert workout["sport"]["label"] == "종목 미확인 (Polar ID 15)"
    assert workout["sport"]["catalogResolved"] is False
    assert workout["name"] == "종목 미확인 (Polar ID 15)"
