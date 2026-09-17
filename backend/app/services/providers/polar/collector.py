"""AccessLink v4 response normalization, independent of transport and credentials.

Contract: https://www.polar.com/polar-api-v4/swagger.yaml
Retain provider responses upstream; never turn missing samples into zero values.
"""

import math
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

SEOUL = ZoneInfo("Asia/Seoul")
OBSERVATION_KEYS = ("heartRateSamples", "metSamples", "stepSamples", "nightlyRecharges", "sleeps")


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
    }[kind]
    # Empty protobuf objects can omit empty repeated fields. A nonempty, unknown
    # shape is a schema failure, not an assertion that no health data exists.
    if root and expected_key not in root:
        raise CollectorSchemaError(f"Missing {expected_key}")
    if kind == "heart_rate":
        container = _object(root.get("continuousSamples"))
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
        container = _object(root.get("activities"))
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
                }
            )
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
                ):
                    value = _number(night.get(key), low, high)
                    if value is not None and value > 0 and (key != "recoveryIndicator" or value.is_integer()):
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
