// Historical filename retained for the existing deployment. No stress score is computed.
function evaluateHealineWindow_(input) {
  var start = input.windowStartMs;
  var end = input.windowEndMs;
  var hr = validSamples_(withinWindow_(input.heartRateSamples || [], start, end), 'heartRate', 30, 220);
  var mets = validSamples_(withinWindow_(input.metSamples || [], start, end), 'met', 0.1, 30);
  var steps = validSamples_(withinWindow_(input.stepSamples || [], start, end), 'steps', 0, 10000);
  var historyStart = start - HEALINE.recentActivityMinutes * 60000;
  var previous = validSamples_(withinWindow_(input.metSamples || [], historyStart, start), 'met', 0.1, 30);
  var metMinutes = coveredMinutes_(mets, start, end);
  var recentMetMinutes = coveredMinutes_(previous, historyStart, start);
  var recentActive = previous.some(function (s) { return s.met >= 2; });
  var result = {
    startMs: start, endMs: end,
    medianHeartRate: hr.length ? round_(median_(hr.map(function (s) { return s.heartRate; })), 1) : null,
    minHeartRate: hr.length ? Math.min.apply(null, hr.map(function (s) { return s.heartRate; })) : null,
    maxHeartRate: hr.length ? Math.max.apply(null, hr.map(function (s) { return s.heartRate; })) : null,
    heartRateSampleCount: hr.length,
    firstHeartRateAt: hr.length ? hr[0].timestampMs : null,
    lastHeartRateAt: hr.length ? Math.max.apply(null, hr.map(function (s) { return s.timestampMs; })) : null,
    averageMet: mets.length ? round_(mean_(mets.map(function (s) { return s.met; })), 2) : null,
    maxMet: mets.length ? Math.max.apply(null, mets.map(function (s) { return s.met; })) : null,
    metMinutes: metMinutes,
    stepMinutes: coveredMinutes_(steps, start, end),
    activeMinutes: coveredMinutes_(mets.filter(function (s) { return s.met >= 2; }), start, end),
    steps: steps.length ? Math.round(steps.reduce(function (sum, s) { return sum + s.steps; }, 0)) : null,
    minuteObservations: buildMinuteObservations_(hr, mets, steps),
    status: 'OBSERVED', baseline: null, heartRateDelta: null,
    isQuiet: false, comparisonEligible: false, comparisonReason: null,
    recentActivity: recentActive, recentActivityMetMinutes: recentMetMinutes,
    recentAverageMet: previous.length ? round_(mean_(previous.map(function (r) { return r.met; })), 2) : null,
    recentActiveMinutes: coveredMinutes_(previous.filter(function (r) { return r.met >= 2; }), historyStart, start)
  };
  var fullHr = hr.length >= HEALINE.minimumHeartRateSamples && hr[hr.length - 1].timestampMs - hr[0].timestampMs >= 5 * 60000;
  var fullActivity = metMinutes >= HEALINE.minimumMetMinutes;
  var active = (result.averageMet !== null && result.averageMet >= 2) || result.steps >= 100;
  var sleeping = (input.sleeps || []).some(function (s) { return s.startMs < end && s.endMs > start; });
  if (!hr.length) result.status = 'NO_DATA';
  else if (sleeping) result.status = 'SLEEP_RECORDED';
  else if (active) result.status = 'ACTIVE';
  else if (!fullHr || !fullActivity || result.stepMinutes < HEALINE.minimumMetMinutes) result.status = 'PARTIAL';
  else if (seoulHourPure_(start) < HEALINE.comparisonStartHour || seoulHourPure_(start) >= HEALINE.comparisonEndHour) {
    result.status = 'NIGHT_OBSERVATION';
  } else if (recentMetMinutes < HEALINE.recentActivityMinutes * 0.8) {
    result.status = 'PARTIAL';
    result.comparisonReason = 'recent_activity_coverage';
  } else {
    // Eligibility means a usable LOW-ACTIVITY observation, not confirmed rest.
    // Recent movement is matched against comparable history, not silently ignored.
    result.comparisonEligible = result.averageMet < 2 && result.steps < 100;
    result.isQuiet = result.averageMet < 1.5 && result.maxMet < 2 && result.steps < 20 && !recentActive;
    if (result.comparisonEligible) {
      result.baseline = resolveBaseline_(input.baseline, start, result);
      result.status = result.baseline ? 'CONTEXT_MATCHED' : 'BUILDING_BASELINE';
      result.comparisonReason = result.baseline ? 'matched_prior_activity' : 'insufficient_matched_history';
      if (result.baseline) {
        result.heartRateDelta = round_(result.medianHeartRate - result.baseline.median, 1);
        if (result.medianHeartRate > result.baseline.upper) result.status = 'ABOVE_USUAL';
      }
    }
  }
  if (!result.comparisonReason) result.comparisonReason = result.status.toLowerCase();
  return result;
}

// Compact observed minute buckets; missing minutes are never interpolated.
// HR distributions describe bpm samples, not beat-to-beat intervals or HRV.
function buildMinuteObservations_(hr, mets, steps) {
  var buckets = {};
  [hr, mets, steps].forEach(function (samples, kind) {
    samples.forEach(function (sample) {
      var minute = Math.floor(sample.timestampMs / 60000) * 60000;
      if (!buckets[minute]) buckets[minute] = [[], [], []];
      buckets[minute][kind].push(sample);
    });
  });
  return Object.keys(buckets).sort().map(function (key) {
    var bucket = buckets[key], heart = bucket[0].map(function (s) { return s.heartRate; });
    return [Number(key), heart.length ? round_(median_(heart), 1) : null,
      heart.length ? Math.min.apply(null, heart) : null, heart.length ? Math.max.apply(null, heart) : null,
      heart.length, bucket[2].length ? Math.round(bucket[2].reduce(function (sum, s) { return sum + s.steps; }, 0)) : null,
      bucket[1].length ? round_(mean_(bucket[1].map(function (s) { return s.met; })), 2) : null,
      bucket[1].length];
  });
}

function validNumber_(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  var number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validSamples_(samples, key, minimum, maximum) {
  var byTime = {};
  samples.forEach(function (sample) {
    var value = validNumber_(sample[key]);
    var timestamp = validNumber_(sample.timestampMs);
    if (value === null || timestamp === null || value < minimum || value > maximum) return;
    // Multiple devices/recordings at the same timestamp must not multiply totals.
    if (!byTime[timestamp] || value > byTime[timestamp][key]) {
      byTime[timestamp] = { timestampMs: timestamp, intervalMs: sample.intervalMs || 60000 };
      byTime[timestamp][key] = value;
    }
  });
  return Object.keys(byTime).map(function (key) { return byTime[key]; })
    .sort(function (a, b) { return a.timestampMs - b.timestampMs; });
}

function coveredMinutes_(samples, start, end) {
  var minutes = {};
  samples.forEach(function (s) {
    var stop = Math.min(end, s.timestampMs + Math.min(s.intervalMs || 60000, 60000));
    for (var time = Math.max(start, s.timestampMs); time < stop; time += 60000) {
      minutes[Math.floor(time / 60000)] = true;
    }
  });
  return Object.keys(minutes).length;
}

function withinWindow_(samples, startMs, endMs) {
  return samples.filter(function (sample) {
    var timestamp = validNumber_(sample.timestampMs);
    return timestamp !== null && timestamp >= startMs && timestamp < endMs;
  });
}

function resolveBaseline_(baseline, timestampMs, context) {
  if (!baseline || baseline.version !== HEALINE.modelVersion || !baseline.days || !context) return null;
  var date = dateKeyPure_(timestampMs);
  var minute = seoulHourPure_(timestampMs) * 60 + new Date(timestampMs).getUTCMinutes();
  var values = [], windowCount = 0, latestDate = '', referenceDates = [];
  Object.keys(baseline.days).sort().forEach(function (day) {
    if (day >= date || localDayStartMs_(date) - localDayStartMs_(day) > HEALINE.baselineDays * 86400000) return;
    var matched = baseline.days[day].filter(function (row) {
      return Math.abs(row[0] - minute) <= 90 && Math.abs(row[2] - context.averageMet) <= 0.35 &&
        (row[3] < 20) === (context.steps < 20) && Math.abs(row[4] - context.activeMinutes) <= 3 &&
        Math.abs(row[5] - context.recentAverageMet) <= 0.5 &&
        Math.abs(row[6] - context.recentActiveMinutes) <= 5;
    });
    if (matched.length) {
      values.push(median_(matched.map(function (row) { return row[1]; })));
      windowCount += matched.length; latestDate = day; referenceDates.push(day);
    }
  });
  if (values.length < HEALINE.baselineMinDays || windowCount < HEALINE.baselineMinWindows ||
      localDayStartMs_(date) - localDayStartMs_(latestDate) > 4 * 86400000) return null;
  var center = median_(values), mad = median_(values.map(function (v) { return Math.abs(v - center); }));
  return {
    median: round_(center, 1),
    upper: round_(Math.max(percentile_(values, 0.9), center + 10, center + 3 * 1.4826 * mad), 1),
    days: values.length, windows: windowCount, dates: referenceDates,
    method: 'activity_context_v3',
    source: '이전 14일 · 시각 ±90분 · 현재와 직전 30분 활동량이 비슷한 기록'
  };
}

function buildHourlyObservations_(windows) {
  var groups = {};
  windows.forEach(function (window) {
    var key = String(Math.floor(window.startMs / 3600000) * 3600000);
    if (!groups[key]) groups[key] = [];
    groups[key].push(window);
  });
  return Object.keys(groups).sort().map(function (key) {
    var rows = groups[key].sort(function (a, b) { return a.startMs - b.startMs; });
    var observed = rows.filter(function (r) { return r.heartRateSampleCount > 0; });
    var streak = 0, longest = 0;
    rows.forEach(function (r) { streak = r.status === 'ABOVE_USUAL' ? streak + 1 : 0; longest = Math.max(longest, streak); });
    var stepRows = rows.filter(function (r) { return r.steps !== null; });
    return {
      startMs: rows[0].startMs, endMs: rows[rows.length - 1].endMs, windows: rows,
      heartRateSampleCount: rows.reduce(function (n, r) { return n + r.heartRateSampleCount; }, 0),
      medianHeartRate: observed.length ? Math.round(median_(observed.map(function (r) { return r.medianHeartRate; }))) : null,
      minHeartRate: observed.length ? Math.min.apply(null, observed.map(function (r) { return r.minHeartRate; })) : null,
      maxHeartRate: observed.length ? Math.max.apply(null, observed.map(function (r) { return r.maxHeartRate; })) : null,
      firstHeartRateAt: observed.length ? observed[0].firstHeartRateAt : null,
      lastHeartRateAt: observed.length ? observed[observed.length - 1].lastHeartRateAt : null,
      steps: stepRows.length ? stepRows.reduce(function (n, r) { return n + r.steps; }, 0) : null,
      activityMinutes: rows.reduce(function (n, r) { return n + r.metMinutes; }, 0),
      stepMinutes: rows.reduce(function (n, r) { return n + r.stepMinutes; }, 0),
      comparedWindows: rows.filter(function (r) { return r.baseline !== null; }).length,
      elevatedWindows: rows.filter(function (r) { return r.status === 'ABOVE_USUAL'; }).length,
      elevatedMinutes: longest * 15,
      activeMinutes: rows.reduce(function (n, r) { return n + r.activeMinutes; }, 0),
      lowMovementMinutes: rows.filter(function (r) { return r.isQuiet; }).length * 15
    };
  });
}

function buildDailySummary_(date, windows, data) {
  var rows = windows.filter(function (r) { return dateKeyPure_(r.startMs) === date; });
  var steps = rows.filter(function (r) { return r.steps !== null; });
  var nights = (data.nightlyRecharges || []).filter(function (n) { return n.sleepResultDate === date; });
  nights.sort(function (a, b) { return String(b.modified || '').localeCompare(String(a.modified || '')); });
  var nightly = nights[0] || null;
  var indicator = nightly ? validNumber_(nightly.recoveryIndicator) : null;
  var labels = { 1: '매우 낮음', 2: '낮음', 3: '다소 낮음', 4: '보통', 5: '좋음', 6: '매우 좋음' };
  var sleep = (data.sleeps || []).filter(function (s) { return s.date === date; })[0] || null;
  return {
    date: date, windows: rows, nightly: nightly, sleep: sleep,
    nightComparison: compareNightlyHistory_(date, nightly, data.nightlyHistory || data.nightlyRecharges || []),
    comparisonEligibleWindows: rows.filter(function (r) { return r.comparisonEligible; }).length,
    comparedWindows: rows.filter(function (r) { return r.baseline; }).length,
    hours: buildHourlyObservations_(rows),
    recoveryLabel: labels[indicator] || '아직 없음', recoveryIndicator: labels[indicator] ? indicator : null,
    steps: steps.length ? steps.reduce(function (n, r) { return n + r.steps; }, 0) : null,
    observedWindows: rows.filter(function (r) { return r.heartRateSampleCount > 0; }).length,
    totalWindows: rows.length,
    heartRateSampleCount: rows.reduce(function (n, r) { return n + r.heartRateSampleCount; }, 0),
    stepMinutes: rows.reduce(function (n, r) { return n + r.stepMinutes; }, 0),
    activityMinutes: rows.reduce(function (n, r) { return n + r.metMinutes; }, 0),
    lastHeartRateAt: rows.reduce(function (n, r) { return Math.max(n, r.lastHeartRateAt || 0); }, 0) || null,
    activeMinutes: rows.reduce(function (n, r) { return n + r.activeMinutes; }, 0),
    sleepAccess: data.sleepAccess,
    source: data.source,
    syncWarning: data.syncWarning || null,
    diagnostics: (data.diagnostics || []).filter(function (entry) { return entry.date === date; }),
    guidance: nightly && validNumber_(nightly.ansRate) !== null && nightly.ansRate <= 2
      ? 'Polar 자율신경 회복이 낮은 단계입니다. 수면 길이·끊김·현재 피로를 함께 확인하세요. 낮의 심리적 스트레스 원인까지 알 수 있는 값은 아닙니다.'
      : indicator !== null && indicator <= 3
      ? '일정 사이 쉬는 시간을 먼저 확보하고, 운동 강도는 오늘 느끼는 피로와 함께 결정하세요.'
      : indicator !== null
        ? '회복 기록과 현재 몸 상태가 일치하는지 확인하고 오늘 일정을 조절하세요.'
        : '오늘 날짜의 회복 기록이 아직 없습니다. 어제 값을 오늘 상태로 사용하지 않습니다.'
  };
}

function compareNightlyHistory_(date, nightly, history) {
  if (!nightly) return null;
  var byDate = {};
  history.forEach(function (n) {
    var distance = localDayStartMs_(date) - localDayStartMs_(n.sleepResultDate);
    if (distance > 0 && distance <= HEALINE.baselineDays * 86400000 &&
        positiveNumber_(n.meanNightlyRecoveryRmssd) && positiveNumber_(n.meanNightlyRecoveryRri)) byDate[n.sleepResultDate] = n;
  });
  var dates = Object.keys(byDate).sort();
  if (dates.length < 5 || localDayStartMs_(date) - localDayStartMs_(dates[dates.length - 1]) > 4 * 86400000) return null;
  var rmssd = median_(dates.map(function (d) { return byDate[d].meanNightlyRecoveryRmssd; }));
  var heart = median_(dates.map(function (d) { return 60000 / byDate[d].meanNightlyRecoveryRri; }));
  var currentRmssd = positiveNumber_(nightly.meanNightlyRecoveryRmssd), rri = positiveNumber_(nightly.meanNightlyRecoveryRri);
  return { reference: 'previous_received_nights_within_14_days', dates: dates, nights: dates.length,
    medianRmssdMs: round_(rmssd, 1), medianHeartRateFromRriBpm: round_(heart, 1),
    rmssdChangePercent: currentRmssd ? round_((currentRmssd / rmssd - 1) * 100, 1) : null,
    heartRateChangeBpm: rri ? round_(60000 / rri - heart, 1) : null };
}

function seoulHourPure_(timestampMs) { return new Date(timestampMs + 9 * 3600000).getUTCHours(); }
function percentile_(values, fraction) {
  if (!values.length) return null;
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var index = (sorted.length - 1) * fraction, low = Math.floor(index), high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}
function median_(values) { return percentile_(values, 0.5); }
function mean_(values) { return values.reduce(function (sum, v) { return sum + v; }, 0) / values.length; }
function round_(value, digits) { var scale = Math.pow(10, digits); return Math.round(value * scale) / scale; }
