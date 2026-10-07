"""AccessLink v4 response normalization, independent of transport and credentials.

Contract: https://www.polar.com/polar-api-v4/swagger.yaml
Retain provider responses upstream; never turn missing samples into zero values.
"""

import math
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from app.constants.workout_types.polar import get_unified_workout_type

SEOUL = ZoneInfo("Asia/Seoul")
OBSERVATION_KEYS = ("heartRateSamples", "metSamples", "stepSamples", "nightlyRecharges", "sleeps", "workouts")
SLEEP_SCORE_COMPONENTS = (
    "continuityScore",
    "efficiencyScore",
    "longInterruptionsTimeScore",
    "groupSolidityScore",
    "groupDurationScore",
    "groupRefreshScore",
    "n3Score",
    "remScore",
)


class CollectorSchemaError(ValueError):
    """The response structure cannot be interpreted using the provider contract."""


def _object(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise CollectorSchemaError("Expected an object")
    return value


def _list(value: Any) -> list[Any]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise CollectorSchemaError("Expected an array")
    return value


def _number(value: Any, low: float, high: float) -> float | None:
    if value is None or isinstance(value, bool) or (isinstance(value, str) and not value.strip()):
        return None
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError):
        return None
    return number if math.isfinite(number) and low <= number <= high else None


def _timestamp(day: date, value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        stamp = datetime.fromisoformat(value if "T" in value else f"{day.isoformat()}T{value}")
        return stamp if stamp.tzinfo else stamp.replace(tzinfo=SEOUL)
    except ValueError:
        return None


def empty_observations() -> dict[str, Any]:
    return {key: [] for key in OBSERVATION_KEYS}


def _deduplicate(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_time = {sample["timestampMs"]: sample for sample in samples}
    return [by_time[key] for key in sorted(by_time)]


def _vector(
    day: date, vector: dict[str, Any], values_key: str, output_key: str, diagnostics: dict[str, Any]
) -> list[dict[str, Any]]:
    values = _list(vector.get(values_key))
    diagnostics["raw_samples"] += len(values)
    start = _timestamp(day, vector.get("startTime"))
    interval = _number(vector.get("interval"), 1, 86_400_000)
    if values and (start is None or interval is None):
        diagnostics["invalid_vectors"] += 1
        return []
    if start is None or interval is None:
        return []
    output = []
    for index, value in enumerate(values):
        parsed = _number(value, 0.1 if output_key == "met" else 0, 31.875 if output_key == "met" else 10000)
        stamp = start + timedelta(milliseconds=index * interval)
        if parsed is None or stamp.astimezone(SEOUL).date() != day:
            diagnostics["rejected_samples"] += 1
            continue
        output.append({"timestampMs": int(stamp.timestamp() * 1000), "intervalMs": interval, output_key: parsed})
    return output


def normalize_polar_response(kind: str, day: date, payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    root = _object(payload.get("data", payload))
    output = empty_observations()
    diagnostics: dict[str, Any] = {
        "code": "ok",
        "response_keys": sorted(root),
        "days": 0,
        "devices": 0,
        "raw_samples": 0,
        "rejected_samples": 0,
        "invalid_vectors": 0,
    }
    expected_key = {
        "heart_rate": "continuousSamples",
        "activity": "activities",
        "sleep": "nightSleeps",
        "recovery": "nightlyRechargeResults",
        "workout": "trainingSessions",
    }[kind]
    day_key = {"heart_rate": "heartRateSamplesPerDay", "activity": "activityDays"}.get(kind)
    # The live REST gateway also returns daily collections without the Swagger wrapper.
    unwrapped_daily = day_key is not None and day_key in root and expected_key not in root
    # Empty protobuf objects can omit empty repeated fields. A nonempty, unknown
    # shape is a schema failure, not an assertion that no health data exists.
    if root and expected_key not in root and not unwrapped_daily:
        raise CollectorSchemaError(f"Missing {expected_key}")
    if kind == "heart_rate":
        container = root if unwrapped_daily else _object(root.get("continuousSamples"))
        if container and "heartRateSamplesPerDay" not in container:
            raise CollectorSchemaError("Missing continuousSamples.heartRateSamplesPerDay")
        days = _list(container.get("heartRateSamplesPerDay"))
        for item in days:
            item = _object(item)
            if item.get("date") != day.isoformat():
                continue
            diagnostics["days"] += 1
            start = datetime.combine(day, time(), SEOUL)
            for sample in _list(item.get("samples")):
                sample = _object(sample)
                diagnostics["raw_samples"] += 1
                offset = _number(sample.get("offsetMillis"), 0, 86_399_999)
                heart_rate = _number(sample.get("heartRate"), 30, 220)
                if offset is None or heart_rate is None:
                    diagnostics["rejected_samples"] += 1
                    continue
                output["heartRateSamples"].append(
                    {
                        "timestampMs": int(start.timestamp() * 1000 + offset),
                        "heartRate": heart_rate,
                        "triggerType": sample.get("triggerType"),
                    }
                )
    elif kind == "activity":
        container = root if unwrapped_daily else _object(root.get("activities"))
        if container and "activityDays" not in container:
            raise CollectorSchemaError("Missing activities.activityDays")
        days = _list(container.get("activityDays"))
        for item in days:
            item = _object(item)
            if item.get("date") != day.isoformat():
                continue
            diagnostics["days"] += 1
            devices = []
            for device in _list(item.get("activitiesPerDevice")):
                diagnostics["devices"] += 1
                mets: list[dict[str, Any]] = []
                steps: list[dict[str, Any]] = []
                for recording in _list(_object(device).get("activitySamples")):
                    recording = _object(recording)
                    mets.extend(_vector(day, _object(recording.get("metSamples")), "mets", "met", diagnostics))
                    steps.extend(_vector(day, _object(recording.get("stepSamples")), "steps", "steps", diagnostics))
                devices.append((_deduplicate(mets), _deduplicate(steps)))
            if devices:
                # Select valid observations from one device, never sum two watches.
                mets, steps = max(devices, key=lambda pair: len(pair[0]) + len(pair[1]))
                output["metSamples"].extend(mets)
                output["stepSamples"].extend(steps)
    elif kind == "sleep":
        for night in _list(root.get("nightSleeps")):
            night = _object(night)
            if night.get("sleepDate") != day.isoformat():
                continue
            diagnostics["days"] += 1
            diagnostics["raw_samples"] += 1
            hypnogram = _object(_object(night.get("sleepResult")).get("hypnogram"))
            start = _timestamp(day, hypnogram.get("sleepStart"))
            end = _timestamp(day, hypnogram.get("sleepEnd"))
            if start is None or end is None or not 0 < (end - start).total_seconds() <= 86400:
                diagnostics["rejected_samples"] += 1
                continue
            output["sleeps"].append(
                {
                    "date": day.isoformat(),
                    "startMs": int(start.timestamp() * 1000),
                    "endMs": int(end.timestamp() * 1000),
                    "durationMinutes": round((end - start).total_seconds() / 60),
                    "score": _number(_object(night.get("sleepScore")).get("sleepScore"), 1, 100),
                    "scores": {
                        key: _number(_object(night.get("sleepScore")).get(key), 0, 100)
                        for key in SLEEP_SCORE_COMPONENTS
                    },
                }
            )
    elif kind == "workout":
        output["workouts"] = _workouts(day, root, diagnostics)
    else:
        nights = root.get("nightlyRechargeResults")
        if isinstance(nights, dict):
            if nights and "nightlyRechargeResults" not in nights:
                raise CollectorSchemaError("Missing nightlyRechargeResults.nightlyRechargeResults")
            nights = nights.get("nightlyRechargeResults")
        for night in _list(nights):
            night = _object(night)
            if night.get("sleepResultDate") == day.isoformat():
                diagnostics["days"] += 1
                diagnostics["raw_samples"] += 1
                normalized_night: dict[str, Any] = {"sleepResultDate": day.isoformat()}
                for key, low, high in (
                    ("recoveryIndicator", 1, 6),
                    ("meanNightlyRecoveryRmssd", 0, math.inf),
                    ("meanNightlyRecoveryRri", 0, math.inf),
                    ("meanBaselineRmssd", 0, math.inf),
                    ("meanBaselineRri", 0, math.inf),
                    ("meanNightlyRecoveryRespirationInterval", 0, math.inf),
                    ("meanBaselineRespirationInterval", 0, math.inf),
                    ("ansRate", 1, 5),
                    ("ansStatus", -15.7068, 15.7068),
                ):
                    value = _number(night.get(key), low, high)
                    # Zero is a meaningful signed ANS status, but an absent interval/HRV sentinel.
                    if key not in ("recoveryIndicator", "ansRate", "ansStatus") and value == 0:
                        continue
                    if value is not None and (key not in ("recoveryIndicator", "ansRate") or value.is_integer()):
                        normalized_night[key] = value
                    elif night.get(key) is not None:
                        diagnostics["rejected_samples"] += 1
                if len(normalized_night) > 1:
                    output["nightlyRecharges"].append(normalized_night)
    for key in ("heartRateSamples", "metSamples", "stepSamples"):
        output[key] = _deduplicate(output[key])
    diagnostics["counts"] = {key: len(value) for key, value in output.items()}
    if not any(output.values()):
        diagnostics["code"] = (
            "invalid_samples" if diagnostics["raw_samples"] else ("no_samples" if diagnostics["days"] else "no_days")
        )
    elif diagnostics["rejected_samples"] or diagnostics["invalid_vectors"]:
        diagnostics["code"] = "partial"
    return output, diagnostics


def _workout_time(value: Any, offset: Any) -> datetime | None:
    if not isinstance(value, str) or "T" not in value:
        return None
    try:
        stamp = datetime.fromisoformat(value)
        minutes = _number(offset, -720, 840)
        if offset is not None and (minutes is None or not minutes.is_integer()):
            return None
        if stamp.tzinfo:
            return stamp.astimezone(timezone(timedelta(minutes=minutes))) if minutes is not None else stamp
        if minutes is not None and minutes.is_integer():
            return stamp.replace(tzinfo=timezone(timedelta(minutes=minutes)))
    except ValueError:
        pass
    return None


def _workout_sport(reference: Any, catalog: dict[str, Any]) -> dict[str, Any]:
    sport_id = str(_object(reference).get("id", ""))
    entry = _object(catalog.get(sport_id))
    name = str(entry.get("name") or "OTHER").upper()
    parent = str(entry.get("parentName") or name).upper()
    return {
        "id": sport_id,
        "name": name,
        "label": str(entry.get("label") or name)[:100],
        "type": get_unified_workout_type(parent, name).value,
    }


def _workout_load(value: Any) -> dict[str, Any]:
    raw = _object(value)
    result: dict[str, Any] = {}
    for key in ("cardioLoad", "muscleLoad", "perceivedLoad"):
        parsed = _number(raw.get(key), 0, 65535)
        if parsed is not None:
            result[key] = parsed
    for key in ("cardioLoadInterpretation", "muscleLoadInterpretation", "perceivedLoadInterpretation", "sessionRpe"):
        if isinstance(raw.get(key), str):
            result[key] = raw[key][:80]
    return result


def _workout_exercise(raw: dict[str, Any], catalog: dict[str, Any]) -> dict[str, Any]:
    statistics = []
    for entry in _list(_object(raw.get("statistics")).get("statistics")):
        entry = _object(entry)
        statistics.append(
            {
                "type": str(entry.get("type") or "UNKNOWN")[:80],
                **{key: _number(entry.get(key), -10000, 10000000) for key in ("min", "avg", "max")},
            }
        )
    zones = []
    for group in _list(raw.get("zones")):
        group = _object(group)
        for zone in _list(group.get("zones")):
            zone = _object(zone)
            low, high = _number(zone.get("lowerLimit"), 0, 100000), _number(zone.get("higherLimit"), 0, 100000)
            duration = _number(zone.get("inZone"), 0, 360000000)
            if low is not None and high is not None and low <= high and duration is not None:
                zones.append(
                    {
                        "type": str(group.get("type") or "UNKNOWN")[:80],
                        "lower": low,
                        "upper": high,
                        "durationSeconds": duration / 1000,
                    }
                )
    samples = _object(raw.get("samples"))
    vectors = _list(samples.get("samples"))
    laps = _object(raw.get("laps"))
    return {
        "id": str(_object(raw.get("identifier")).get("id", "")),
        "sport": _workout_sport(raw.get("sport"), catalog),
        "durationSeconds": _millis_seconds(raw.get("durationMillis")),
        "distanceMeters": _number(raw.get("distanceMeters"), 0, 9999000),
        "energyKcal": _number(raw.get("calories"), 0, 65535),
        "ascentMeters": _number(raw.get("ascentMeters"), 0, 99000),
        "descentMeters": _number(raw.get("descentMeters"), 0, 99000),
        "runningIndex": _number(raw.get("runningIndex"), 25, 100),
        "statistics": statistics,
        "zones": zones,
        "trainingLoad": _workout_load(raw.get("trainingLoadReport")),
        "detailCounts": {
            "sampleValues": sum(len(_list(_object(vector).get("values"))) for vector in vectors),
            "rrSamples": len(_list(samples.get("rrSamples"))),
            "manualLaps": len(_list(laps.get("laps"))),
            "automaticLaps": len(_list(laps.get("autoLaps"))),
            "strengthRounds": len(_list(_object(raw.get("strengthTrainingResults")).get("completedRounds"))),
        },
    }


def _millis_seconds(value: Any) -> float | None:
    parsed = _number(value, 0, 360000000)
    return parsed / 1000 if parsed is not None else None


def _workouts(day: date, root: dict[str, Any], diagnostics: dict[str, Any]) -> list[dict[str, Any]]:
    catalog = _object(root.get("healineSportCatalog"))
    sessions: dict[str, dict[str, Any]] = {}
    for raw in _list(root.get("trainingSessions")):
        raw = _object(raw)
        diagnostics["raw_samples"] += 1
        identifier = _object(raw.get("identifier")).get("id")
        offset = raw.get("timezoneOffsetMinutes")
        start = _workout_time(raw.get("startTime"), offset)
        end = _workout_time(raw.get("stopTime"), offset)
        duration = _millis_seconds(raw.get("durationMillis"))
        if (
            not isinstance(identifier, str)
            or not 1 <= len(identifier) <= 64
            or start is None
            or end is None
            or not 0 < (end - start).total_seconds() <= 7 * 86400
            or duration is None
            or duration <= 0
            or duration > (end - start).total_seconds() + 1
        ):
            diagnostics["rejected_samples"] += 1
            continue
        # Date filtering belongs to the API's local date, before Seoul display conversion.
        if start.date() != day:
            continue
        diagnostics["days"] = 1
        exercises = [_workout_exercise(_object(exercise), catalog) for exercise in _list(raw.get("exercises"))]
        sport = _workout_sport(raw.get("sport"), catalog)
        if not sport["id"] and len(exercises) == 1:
            sport = exercises[0]["sport"]
        utc_offset = start.utcoffset()
        assert utc_offset is not None  # _workout_time accepts only resolved time zones.
        minutes = int(utc_offset.total_seconds() / 60)
        heart_min = [
            s["min"]
            for e in exercises
            for s in e["statistics"]
            if s["type"] == "STATISTICS_TYPE_HEART_RATE" and _number(s["min"], 30, 240) is not None
        ]
        entry = {
            "id": identifier,
            "date": start.astimezone(SEOUL).date().isoformat(),
            "startMs": int(start.timestamp() * 1000),
            "endMs": int(end.timestamp() * 1000),
            "durationSeconds": duration,
            "elapsedSeconds": (end - start).total_seconds(),
            "zoneOffset": f"{'+' if minutes >= 0 else '-'}{abs(minutes) // 60:02}:{abs(minutes) % 60:02}",
            "modifiedAt": raw.get("modified"),
            "name": str(raw.get("name") or sport["label"])[:100],
            "sport": sport,
            "distanceMeters": _number(raw.get("distanceMeters"), 0, 9999000),
            "energyKcal": _number(raw.get("calories"), 0, 65535),
            "heartRateAvgBpm": _number(raw.get("hrAvg"), 30, 240),
            "heartRateMaxBpm": _number(raw.get("hrMax"), 30, 240),
            "heartRateMinBpm": min(heart_min) if heart_min else None,
            "trainingLoad": _workout_load(raw.get("trainingLoadReport")),
            "polarTrainingLoad": _number(raw.get("trainingLoad"), 0, 65535),
            "trainingBenefit": raw.get("trainingBenefit"),
            "recoveryTimeSeconds": _millis_seconds(raw.get("recoveryTimeMillis")),
            "exercises": exercises,
            "source": "polar_accesslink_v4",
        }
        previous = sessions.get(identifier)
        if previous is None or str(entry["modifiedAt"] or "") >= str(previous["modifiedAt"] or ""):
            sessions[identifier] = entry
    return sorted(sessions.values(), key=lambda item: item["startMs"])
