"""Training and recovery context derived from retained Polar observations.

Every value is a descriptive comparison with the same user's earlier records. The windows,
minimum counts and coverage rules are display choices; none is a validated injury, illness
or stress predictor, and missing collection is never treated as rest or zero load.
"""

from datetime import date, datetime, timedelta
from statistics import median
from typing import Any

from app.services.providers.polar.collector import SEOUL

NIGHT_REFERENCE_DAYS = 14
NIGHT_REFERENCE_MIN = 5
NIGHT_REFERENCE_MAX_GAP_DAYS = 4
TRAINING_WINDOW_DAYS = 28
ACUTE_DAYS = 7
# Collection must have answered for most days before a sum can stand for the period.
MIN_COVERED_DAYS_28 = 24
MIN_COVERED_DAYS_7 = 6
MIN_PATTERN_NIGHTS = 3
MIN_TEMPERATURE_SAMPLES = 10
HISTORY_DAYS = TRAINING_WINDOW_DAYS + NIGHT_REFERENCE_DAYS


def local_date(timestamp_ms: float) -> date:
    return datetime.fromtimestamp(timestamp_ms / 1000, SEOUL).date()


def _positive(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        return None
    return float(value)


def nights_by_date(nights: list[dict[str, Any]]) -> dict[date, dict[str, Any]]:
    return {date.fromisoformat(night["sleepResultDate"]): night for night in nights}


def compare_night(target: date, nights: dict[date, dict[str, Any]]) -> dict[str, Any] | None:
    """Compare one night with the median of up to 14 earlier received nights."""
    night = nights.get(target)
    if night is None:
        return None
    rmssd = _positive(night.get("meanNightlyRecoveryRmssd"))
    rri = _positive(night.get("meanNightlyRecoveryRri"))
    prior = sorted(
        day
        for day, item in nights.items()
        if 0 < (target - day).days <= NIGHT_REFERENCE_DAYS
        and _positive(item.get("meanNightlyRecoveryRmssd"))
        and _positive(item.get("meanNightlyRecoveryRri"))
    )
    result: dict[str, Any] = {
        "date": target.isoformat(),
        "rmssdMs": rmssd,
        "heartRateFromRriBpm": round(60000 / rri, 1) if rri else None,
        "ansRate": night.get("ansRate"),
        "referenceNights": len(prior),
        "rmssdChangePercent": None,
        "heartRateChangeBpm": None,
    }
    if len(prior) < NIGHT_REFERENCE_MIN or (target - prior[-1]).days > NIGHT_REFERENCE_MAX_GAP_DAYS:
        return result
    reference_rmssd = median(nights[day]["meanNightlyRecoveryRmssd"] for day in prior)
    reference_heart = median(60000 / nights[day]["meanNightlyRecoveryRri"] for day in prior)
    result["referenceRmssdMs"] = round(reference_rmssd, 1)
    result["referenceHeartRateBpm"] = round(reference_heart, 1)
    if rmssd:
        result["rmssdChangePercent"] = round((rmssd / reference_rmssd - 1) * 100, 1)
    if rri:
        result["heartRateChangeBpm"] = round(60000 / rri - reference_heart, 1)
    return result


def night_after(workout: dict[str, Any], sleeps: list[dict[str, Any]]) -> tuple[date, str]:
    """Return the first night after a workout and how it was identified."""
    end = workout["endMs"]
    following = [sleep for sleep in sleeps if end <= sleep["startMs"] < end + 86_400_000]
    if following:
        return date.fromisoformat(min(following, key=lambda sleep: sleep["startMs"])["date"]), "sleep_record"
    finished = datetime.fromtimestamp(end / 1000, SEOUL)
    # Without a sleep record, assume the night ending on the next local morning.
    return (finished.date() if finished.hour < 4 else finished.date() + timedelta(days=1)), "date_rule"


def workout_responses(
    workouts: list[dict[str, Any]],
    all_workouts: list[dict[str, Any]],
    sleeps: list[dict[str, Any]],
    nights: dict[date, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    after = {workout["id"]: night_after(workout, sleeps) for workout in all_workouts}
    responses = {}
    for workout in workouts:
        night, matched_by = after.get(workout["id"]) or night_after(workout, sleeps)
        comparison = compare_night(night, nights)
        responses[workout["id"]] = {
            "night": night.isoformat(),
            "matchedBy": matched_by,
            "status": "received" if comparison else "not_received",
            "comparison": comparison,
            # Several sessions before one night cannot be separated.
            "sharedWithWorkouts": sorted(
                other for other, (day, _) in after.items() if day == night and other != workout["id"]
            ),
        }
    return responses


def _cardio_load(workouts: list[dict[str, Any]]) -> float | None:
    values = [_positive((workout.get("trainingLoad") or {}).get("cardioLoad")) for workout in workouts]
    if any(value is None for value in values):
        # A session without a provider load makes the sum incomplete, not smaller.
        return None
    return round(sum(value for value in values if value is not None), 1)


def _heart_rate_zones(workouts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Polar omits zones without time, so a position index is not a stable zone number.
    seconds: dict[tuple[float, float], float] = {}
    for workout in workouts:
        for exercise in workout.get("exercises") or []:
            for zone in exercise.get("zones") or []:
                if zone.get("type") == "ZONE_TYPE_HEART_RATE":
                    key = (zone["lower"], zone["upper"])
                    seconds[key] = seconds.get(key, 0) + zone["durationSeconds"]
    return [
        {"lowerBpm": low, "upperBpm": high, "seconds": round(seconds[(low, high)])} for low, high in sorted(seconds)
    ]


def training_day(
    target: date,
    workouts: list[dict[str, Any]],
    covered_dates: set[date],
    sleeps: list[dict[str, Any]],
    nights: dict[date, dict[str, Any]],
) -> dict[str, Any]:
    window = [target - timedelta(days=offset) for offset in range(TRAINING_WINDOW_DAYS)]
    in_window = [w for w in workouts if window[-1] <= local_date(w["startMs"]) <= target]
    acute = [w for w in in_window if local_date(w["startMs"]) > target - timedelta(days=ACUTE_DAYS)]
    covered_28 = sum(day in covered_dates for day in window)
    covered_7 = sum(day in covered_dates for day in window[:ACUTE_DAYS])
    acute_load = _cardio_load(acute) if covered_7 >= MIN_COVERED_DAYS_7 else None
    total_load = _cardio_load(in_window) if covered_28 >= MIN_COVERED_DAYS_28 else None
    chronic_weekly = round(total_load * ACUTE_DAYS / TRAINING_WINDOW_DAYS, 1) if total_load is not None else None
    after = {night_after(w, sleeps)[0] for w in in_window}
    changes: dict[str, list[float]] = {"afterWorkout": [], "withoutWorkout": []}
    for day in window:
        comparison = compare_night(day, nights)
        if comparison and comparison["rmssdChangePercent"] is not None:
            changes["afterWorkout" if day in after else "withoutWorkout"].append(comparison["rmssdChangePercent"])
    return {
        "date": target.isoformat(),
        "workoutCollectionCoveredDays28": covered_28,
        "workoutCollectionCoveredDays7": covered_7,
        "sessions7": len(acute),
        "durationSeconds7": round(sum(w["durationSeconds"] for w in acute)),
        "cardioLoad7": acute_load,
        "cardioLoad28WeeklyAverage": chronic_weekly,
        "acuteToWeeklyAverageRatio": round(acute_load / chronic_weekly, 2)
        if acute_load is not None and chronic_weekly
        else None,
        "heartRateZones7": _heart_rate_zones(acute),
        "nightRmssdChange28": {
            key: {
                "nights": len(values),
                "medianPercent": round(median(values), 1) if len(values) >= MIN_PATTERN_NIGHTS else None,
            }
            for key, values in changes.items()
        },
    }


def temperature_nights(
    dates: list[date], samples: list[dict[str, Any]], sleeps: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Median skin temperature inside each recorded sleep interval, compared with prior nights."""
    skin = {sample["timestampMs"]: sample["celsius"] for sample in samples if sample["type"] == "skin"}
    by_date = {date.fromisoformat(sleep["date"]): sleep for sleep in sleeps}
    cache: dict[date, tuple[float, int] | None] = {}

    def night(day: date) -> tuple[float, int] | None:
        if day not in cache:
            sleep = by_date.get(day)
            values = [value for stamp, value in skin.items() if sleep and sleep["startMs"] <= stamp < sleep["endMs"]]
            cache[day] = (round(median(values), 2), len(values)) if len(values) >= MIN_TEMPERATURE_SAMPLES else None
        return cache[day]

    output = []
    for day in dates:
        current = night(day)
        prior = [
            value
            for offset in range(1, NIGHT_REFERENCE_DAYS + 1)
            if (value := night(day - timedelta(days=offset))) is not None
        ]
        entry: dict[str, Any] = {
            "date": day.isoformat(),
            "status": "measured" if current else ("no_sleep_interval" if day not in by_date else "no_samples"),
            "medianCelsius": current[0] if current else None,
            "samples": current[1] if current else 0,
            "referenceNights": len(prior),
            "referenceMedianCelsius": None,
            "deviationCelsius": None,
        }
        if current and len(prior) >= NIGHT_REFERENCE_MIN:
            reference = median(value for value, _ in prior)
            entry["referenceMedianCelsius"] = round(reference, 2)
            entry["deviationCelsius"] = round(current[0] - reference, 2)
        output.append(entry)
    return output
