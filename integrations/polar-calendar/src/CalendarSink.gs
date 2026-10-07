function getOrCreateHealineCalendar_() {
  var calendar = CalendarApp.getCalendarById(HEALINE.calendarId);
  if (!calendar || !calendar.isOwnedByMe()) {
    throw new Error('기존 Healine 캘린더에 접근할 수 없습니다. 배포 계정과 캘린더 연결을 확인하세요.');
  }
  return calendar;
}

function hourKey_(time) { return dateKeyPure_(time) + '-' + String(seoulHourPure_(time)).padStart(2, '0'); }
function findHealineEvent_(events, tag, key) {
  // Calendar service getters are remote operations: index each tag once per poll.
  if (!events.healineIndexes) events.healineIndexes = {};
  if (!events.healineIndexes[tag]) {
    var index = {};
    events.forEach(function (event) {
      var value = event.getTag(tag);
      if (value && !index[value]) index[value] = event;
    });
    events.healineIndexes[tag] = index;
  }
  return events.healineIndexes[tag][key] || null;
}

function upsertManagedEvent_(calendar, events, spec) {
  var event = findHealineEvent_(events, spec.tag, spec.key);
  var notes = '';
  if (spec.notes) {
    var marker = '\n\n[내 메모]\n';
    var previous = event ? event.getDescription() : '';
    var markerIndex = previous.indexOf(marker);
    notes = marker + (markerIndex >= 0
      ? previous.slice(markerIndex + marker.length) : '몸 상태·카페인·운동·업무 상황을 적어두면 기록과 비교할 수 있습니다.');
  }
  // Calendar can silently truncate long descriptions. Keep the data block and
  // notes whole; shorten only generated prose, before making any mutation.
  if (spec.description.length + notes.length > 8000 && spec.compactDescription) {
    spec.description = spec.compactDescription();
  }
  spec.description += notes;
  if (spec.description.length > 8000) {
    throw new Error('캘린더 설명 길이 한도: ' + spec.key + '. 기존 기록과 메모는 유지했습니다.');
  }
  if (!event) {
    event = spec.allDay
      ? calendar.createAllDayEvent(spec.title, new Date(spec.startMs), { description: spec.description })
      : calendar.createEvent(spec.title, new Date(spec.startMs), new Date(spec.endMs), { description: spec.description });
    event.setTag(spec.tag, spec.key);
    event.removeAllReminders();
    event.setTransparency(CalendarApp.EventTransparency.TRANSPARENT);
    events.push(event);
    events.healineIndexes[spec.tag][spec.key] = event;
  } else {
    if (event.getTitle() !== spec.title) event.setTitle(spec.title);
    if (event.getDescription() !== spec.description) event.setDescription(spec.description);
    if (!spec.allDay && (event.getStartTime().getTime() !== spec.startMs || event.getEndTime().getTime() !== spec.endMs)) {
      event.setTime(new Date(spec.startMs), new Date(spec.endMs));
    }
  }
  if (event.getTag('healineColor') !== String(spec.color)) {
    event.setColor(spec.color);
    event.setTag('healineColor', String(spec.color));
  }
  return event;
}

function upsertHealineHour_(calendar, events, hour) {
  return upsertManagedEvent_(calendar, events, {
    tag: 'healineHour', key: hourKey_(hour.startMs), startMs: hour.startMs, endMs: hour.endMs,
    title: hourlyTitle_(hour), description: hourlyDescription_(hour), notes: true,
    compactDescription: function () { return compactHourlyDescription_(hour); },
    color: hour.elevatedMinutes >= 30 ? CalendarApp.EventColor.ORANGE :
      hour.activeMinutes > 0 || hour.steps >= 100 ? CalendarApp.EventColor.BLUE : CalendarApp.EventColor.GRAY
  });
}

function compactHourlyDescription_(hour) {
  var lines = ['Healine · 시간대별 관측 · ' + formatDateTime_(new Date(hour.startMs)),
    '기록된 구간의 심박이며 스트레스 점수가 아닙니다. 빈 구간은 보간하지 않습니다.'];
  hour.windows.forEach(function (row) {
    var line = clockTime_(row.startMs) + ' · 심박 ' + displayValue_(row.medianHeartRate) + ' bpm';
    if (row.baseline) line += ' · 이전 ' + row.baseline.days + '일 기준 ' + row.baseline.median +
      ' · 차이 ' + signed_(row.heartRateDelta);
    else line += ' · 개인 비교 보류';
    lines.push(line);
  });
  lines.push(calendarDataBlock_(hourlyCalendarData_(hour)), '[healine-hour:' + hourKey_(hour.startMs) + ']');
  return lines.join('\n');
}

function hourlyTitle_(hour) {
  if (!hasHourlyObservations_(hour)) return '⌛ 관측 미수신';
  var title = hour.elevatedMinutes >= 30 ? '🫀 비슷한 활동 대비 심박 ↑' :
    hour.activeMinutes > 0 || hour.steps >= 100 || hour.medianHeartRate === null ? '🚶 활동 기록' : '🫀 심박 기록';
  if (hour.medianHeartRate !== null) title += ' · ' + hour.medianHeartRate + ' bpm';
  if (hour.steps !== null) title += ' · ' + hour.steps + '보';
  return title;
}

function hourlyDescription_(hour) {
  var lines = ['Healine · 시간대별 관측',
    formatDateTime_(new Date(hour.startMs)) + '–' + clockTime_(hour.endMs) + ' (Asia/Seoul)',
    '아래 수치는 기록된 구간의 값이며 스트레스 점수가 아닙니다.',
    '실제 심박 측정 범위: ' + measurementRange_(hour.firstHeartRateAt, hour.lastHeartRateAt),
    '제목의 심박은 15분 중앙값들의 중앙값입니다. 빈 구간은 보간하지 않습니다.', ''];
  if (hour.elevatedMinutes >= 30) {
    lines.push('활동량이 비슷한 과거 기록과 비교한 15분 구간 ' + hour.elevatedMinutes / 15 + '개에서 연속으로 표시 경계를 넘었습니다.');
    lines.push('당시의 운동·카페인·몸 상태·일정을 함께 확인하고, 여유가 생기면 잠깐 쉬며 현재 느낌과 비교해 보세요.', '');
  }
  var labels = {
    NO_DATA: '심박 미수신', PARTIAL: '심박 또는 활동 기록 부족', ACTIVE: '활동 기록 있음',
    WORKOUT_RECORDED: 'Polar 운동 기록과 겹치는 구간', AFTER_WORKOUT: '운동 종료 후 30분 · 개인 심박 비교 보류',
    AFTER_ACTIVITY: '최근 30분에 활동 기록 있음', OBSERVED: '관측값', SLEEP_RECORDED: 'Polar 수면 기록과 겹치는 구간',
    NIGHT_OBSERVATION: '야간 · 개인 심박 비교 보류',
    LOW_MOVEMENT: '낮은 활동 기록', CONTEXT_MATCHED: '비슷한 활동 기록과 비교',
    BUILDING_BASELINE: '비슷한 활동의 개인 기준 누적 중', ABOVE_USUAL: '비슷한 활동 대비 심박 높음'
  };
  hour.windows.forEach(function (row) {
    var line = clockTime_(row.startMs) + '–' + clockTime_(row.endMs) + ' · ' + labels[row.status];
    if (row.medianHeartRate !== null) line += ' · 심박 중앙값 ' + row.medianHeartRate + ' bpm (' +
      row.minHeartRate + '–' + row.maxHeartRate + ' bpm)';
    lines.push(line);
    if (row.baseline) lines.push('  이전 ' + row.baseline.days + '일·' + row.baseline.windows + '구간 기준 ' + row.baseline.median +
      ' bpm / 차이 ' + signed_(row.heartRateDelta) + ' bpm / 표시 경계 ' + row.baseline.upper + ' bpm');
    if (row.baseline) lines.push('  비교 조건: ' + row.baseline.source);
    lines.push('  직전 30분: 평균 MET ' + displayValue_(row.recentAverageMet) +
      ' · MET 2 이상 ' + displayValue_(row.recentActiveMinutes) + '분 · 수신 ' + row.recentActivityMetMinutes + '/30분');
    lines.push('  심박 ' + row.heartRateSampleCount + '개 · 실제 측정 ' + measurementRange_(row.firstHeartRateAt, row.lastHeartRateAt));
    lines.push('  평균 MET ' + displayValue_(row.averageMet) + ' · 최대 MET ' + displayValue_(row.maxMet) +
      ' · MET 2 이상 관측 ' + (row.metMinutes ? row.activeMinutes + '분' : '미수신'));
    lines.push('  활동 기록 ' + row.metMinutes + '/15분 · 걸음 ' +
      (row.steps === null ? '미수신' : row.steps + '보') + ' (걸음 기록 ' + row.stepMinutes + '/15분)');
  });
  lines.push('', '심박만으로 긴장·감정·질환의 원인을 구분하지 않습니다. 수면 회복 수치는 낮 심박에 가산하지 않습니다.',
    '아래 분석용 기록에는 관측 샘플을 시각별로 묶은 1분 집계가 있습니다. 누락된 분은 관측값이 없는 분입니다.' +
      (hour.source === 'healine-platform' ? ' 원본은 Healine에 보관됩니다.' : ''),
    calendarDataBlock_(hourlyCalendarData_(hour)),
    '[healine-hour:' + hourKey_(hour.startMs) + ']');
  return lines.join('\n');
}

function upsertHealineDay_(calendar, events, summary) {
  var title = '🌿 회복 ' + summary.recoveryLabel;
  if (summary.syncWarning) title = '⚠️ 수집 중단 · 회복 ' + summary.recoveryLabel;
  if (summary.sleep) title += ' · 수면 구간 ' + durationText_(summary.sleep.durationMinutes);
  if ((summary.workouts || []).length) title += ' · 운동 ' + summary.workouts.length + '회';
  if (summary.steps !== null) title += ' · 관측 ' + summary.steps + '보';
  return upsertManagedEvent_(calendar, events, {
    tag: 'healineDay', key: summary.date, allDay: true, startMs: localDayStartMs_(summary.date),
    title: title, description: dailyDescription_(summary), notes: true,
    compactDescription: function () { return 'Healine · ' + summary.date + ' 하루 요약\n' + summary.guidance +
      '\n자세한 측정값은 아래 분석 데이터와 시간대별 기록을 확인하세요.\n' +
      calendarDataBlock_(dailyCalendarData_(summary)) + '\n[healine-day:' + summary.date + ']'; },
    color: summary.recoveryIndicator === null ? CalendarApp.EventColor.GRAY :
      summary.recoveryIndicator <= 3 ? CalendarApp.EventColor.ORANGE : CalendarApp.EventColor.GREEN
  });
}

function workoutCalendarData_(workout, compact) {
  var data = {
    schema: 'healine.calendar.v1', kind: 'workout', modelVersion: HEALINE.modelVersion,
    id: workout.id, source: workout.source, sport: workout.sport, name: workout.name,
    start: isoTimestamp_(workout.startMs), end: isoTimestamp_(workout.endMs),
    sourceZoneOffset: workout.zoneOffset, durationSeconds: workout.durationSeconds,
    elapsedSeconds: workout.elapsedSeconds, distanceMeters: workout.distanceMeters, energyKcal: workout.energyKcal,
    heartRate: { avgBpm: workout.heartRateAvgBpm, minBpm: workout.heartRateMinBpm, maxBpm: workout.heartRateMaxBpm },
    trainingLoad: workout.trainingLoad, polarTrainingLoad: workout.polarTrainingLoad,
    trainingBenefit: workout.trainingBenefit, recoveryTimeSeconds: workout.recoveryTimeSeconds,
    exerciseCount: (workout.exercises || []).length,
    detailStorage: 'healine_platform_raw_collector_response',
    modifiedAt: workout.modifiedAt,
    exercises: compact ? undefined : workout.exercises
  };
  if (compact) data.exerciseDetailsOmittedFromCalendar = true;
  return data;
}

function workoutDurationText_(seconds) {
  var total = Math.round(seconds), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60);
  return (hours ? hours + '시간 ' : '') + minutes + '분' + (total % 60 ? ' ' + total % 60 + '초' : '');
}

function workoutDescription_(workout, compact) {
  var lines = ['Healine · Polar 운동 기록',
    workout.sport.label + ' · ' + workout.name,
    formatDateTime_(new Date(workout.startMs)) + '–' + formatDateTime_(new Date(workout.endMs)) + ' (Asia/Seoul)',
    '운동 시간: ' + workoutDurationText_(workout.durationSeconds) +
      ' · 시작–종료 경과: ' + workoutDurationText_(workout.elapsedSeconds)];
  if (workout.distanceMeters !== null) lines.push('거리: ' + round_(workout.distanceMeters / 1000, 2) + ' km');
  if (workout.energyKcal !== null) lines.push('칼로리: ' + workout.energyKcal + ' kcal');
  lines.push('운동 심박: 평균 ' + displayValue_(workout.heartRateAvgBpm) +
    ' · 최대 ' + displayValue_(workout.heartRateMaxBpm) + ' bpm');
  if (workout.trainingLoad && workout.trainingLoad.cardioLoad !== undefined) {
    lines.push('Polar 심장 부하: ' + workout.trainingLoad.cardioLoad +
      ' · ' + (workout.trainingLoad.cardioLoadInterpretation || '해석 미수신'));
  }
  lines.push('훈련 부하는 운동량 지표입니다. 심리적 스트레스 점수로 해석하지 않습니다.',
    '랩·심박 구간·샘플·근력 세트의 제공된 원본은 Healine에 보관합니다.',
    compact ? '캘린더 길이 제한으로 세부 종목 정보는 원본 저장소에 보존합니다.' : '',
    calendarDataBlock_(workoutCalendarData_(workout, compact)), '[healine-workout:' + workout.id + ']');
  return lines.filter(function (line) { return line !== ''; }).join('\n');
}

function upsertHealineWorkout_(calendar, events, workout) {
  var props = PropertiesService.getUserProperties(), property = 'HEALINE_WORKOUT_EVENT_' + workout.id;
  if (!findHealineEvent_(events, 'healineWorkout', workout.id)) {
    var eventId = props.getProperty(property), known = eventId ? calendar.getEventById(eventId) : null;
    if (known) {
      if (known.getTag('healineWorkout') !== workout.id) throw new Error('운동 기록 ID 확인 필요');
      events.push(known); events.healineIndexes.healineWorkout[workout.id] = known;
    }
  }
  var title = '🏋️ ' + workout.sport.label + ' · ' + workoutDurationText_(workout.durationSeconds);
  if (workout.distanceMeters !== null && workout.distanceMeters > 0) title += ' · ' + round_(workout.distanceMeters / 1000, 2) + ' km';
  var event = upsertManagedEvent_(calendar, events, {
    tag: 'healineWorkout', key: workout.id, startMs: workout.startMs, endMs: workout.endMs,
    title: title, description: workoutDescription_(workout, false),
    compactDescription: function () { return workoutDescription_(workout, true); },
    notes: true, color: CalendarApp.EventColor.MAUVE
  });
  props.setProperty(property, event.getId());
  return event;
}

function dailyDescription_(summary) {
  var lines = ['Healine · ' + summary.date + ' 하루 요약', '', '오늘 참고할 점', summary.guidance, '', '밤사이 회복'];
  if (summary.syncWarning) lines.splice(2, 0, '수집 상태: ' + summary.syncWarning, '마지막 저장 기록을 표시합니다. 측정 날짜와 시각을 확인하세요.', '');
  var n = summary.nightly;
  lines.push('Polar Nightly Recharge: ' + summary.recoveryLabel + (n ? ' (' + n.sleepResultDate + ')' : ''));
  if (n) {
    var ans = validNumber_(n.ansRate), ansStatus = validNumber_(n.ansStatus);
    if (ans !== null && ans >= 1 && ans <= 5) lines.push('Polar 자율신경 회복(ANS): ' + ans + '/5 단계 (1 최저, 5 최고)' +
      (ansStatus !== null ? ' · 평소 대비 ANS 값 ' + signed_(round_(ansStatus, 2)) : ''));
    var rri = positiveNumber_(n.meanNightlyRecoveryRri);
    var baselineRri = positiveNumber_(n.meanBaselineRri);
    var hrv = positiveNumber_(n.meanNightlyRecoveryRmssd);
    var baselineHrv = positiveNumber_(n.meanBaselineRmssd);
    if (rri) lines.push('야간 심박(평균 박동 간격 환산): ' + round_(60000 / rri, 1) + ' bpm' +
      (baselineRri ? ' · 평소 ' + round_(60000 / baselineRri, 1) + ' bpm' : ''));
    if (hrv) lines.push('야간 HRV(RMSSD): ' + hrv + ' ms' +
      (baselineHrv ? ' · 평소 ' + baselineHrv + ' ms (' + signed_(Math.round((hrv / baselineHrv - 1) * 100)) + '%)' : ''));
    if (rri || hrv) lines.push('야간 지표는 수면 초반의 측정값입니다. 낮 시간 스트레스 측정값이 아닙니다.');
    if (summary.nightComparison) {
      var reference = summary.nightComparison;
      lines.push('이전 14일 중 수신된 ' + reference.nights + '밤의 중앙값과 비교 (Polar 자체 기준과 별도):');
      if (reference.rmssdChangePercent !== null) lines.push('  HRV 기준 ' + reference.medianRmssdMs +
        ' ms · 변화 ' + signed_(reference.rmssdChangePercent) + '%');
      if (reference.heartRateChangeBpm !== null) lines.push('  환산 심박 기준 ' + reference.medianHeartRateFromRriBpm +
        ' bpm · 변화 ' + signed_(reference.heartRateChangeBpm) + ' bpm');
    }
  }
  if (summary.sleep) {
    lines.push('수면 구간: ' + clockTime_(summary.sleep.startMs) + '–' + clockTime_(summary.sleep.endMs) +
      ' (' + durationText_(summary.sleep.durationMinutes) + ', 중간 각성 포함)');
    if (summary.sleep.score !== null) lines.push('Polar 수면 점수: ' + round_(summary.sleep.score, 1) + '/100');
    var scores = summary.sleep.scores || {};
    [['수면 견고성', 'groupSolidityScore'], ['수면 연속성', 'continuityScore'],
      ['긴 각성 관련', 'longInterruptionsTimeScore'], ['수면 효율 관련', 'efficiencyScore'],
      ['수면량', 'groupDurationScore'], ['수면 재생', 'groupRefreshScore']].forEach(function (entry) {
      var value = validNumber_(scores[entry[1]]);
      if (value !== null) lines.push(entry[0] + ' 점수: ' + round_(value, 1) + '/100');
    });
    if (Object.keys(scores).length) lines.push('세부 값은 Polar의 점수입니다. 효율 비율(%)이나 각성 시간(분)이 아닙니다.');
  } else {
    lines.push('수면 시간: ' + (summary.sleepAccess === 'needs_connection'
      ? '추가 연결 필요. Healine 설정 화면에서 Polar를 다시 연결하면 수면 읽기가 추가됩니다.'
      : summary.sleepAccess === 'error' ? '조회 실패, 다음 실행에서 다시 확인합니다.' : '아직 미수신'));
  }
  lines.push('', '활동과 기록 범위', '관측된 걸음: ' + (summary.steps === null ? '미수신' : summary.steps + '보'),
    'MET 2 이상으로 기록된 시간: ' + (summary.activityMinutes ? summary.activeMinutes + '분' : '미수신'),
    '활동 데이터가 있는 시간: ' + summary.activityMinutes + '분',
    '걸음 데이터가 있는 시간: ' + summary.stepMinutes + '분',
    '심박 샘플 수: ' + summary.heartRateSampleCount + '개',
    '심박 기록이 있는 15분 구간: ' + summary.observedWindows + '/' + summary.totalWindows + '개',
    '활동 조건을 갖춘 15분 구간 중 개인 비교 가능: ' + (summary.comparedWindows || 0) + '/' +
      (summary.comparisonEligibleWindows || 0) + '개',
    '마지막 심박 시각: ' + (summary.lastHeartRateAt ? formatDateTime_(new Date(summary.lastHeartRateAt)) : '미수신'),
    '빈 구간은 휴식이나 0걸음으로 계산하지 않습니다. Flow 동기화 후 최근 기록과 과거 보충 대상을 다시 반영합니다.');
  lines.push('', '운동 기록');
  if ((summary.workouts || []).length) {
    summary.workouts.forEach(function (w) {
      lines.push(clockTime_(w.startMs) + ' · ' + w.sport.label + ' · ' + durationText_(w.durationSeconds / 60));
    });
    lines.push('운동별 상세 기록은 해당 시간의 🏋️ 일정에 있습니다. 운동 거리·칼로리는 일상 활동과 중복 합산하지 않습니다.');
  } else {
    lines.push(summary.workoutAccess === 'needs_connection' ? '운동 조회 권한이 필요합니다. Healine의 Polar 연결에서 추가 허용하세요.' :
      summary.workoutAccess === 'error' ? '운동 조회 실패 · 기존 기록은 유지됩니다.' :
      summary.workoutAccess === 'granted' ? 'Polar에서 반환한 운동 기록이 없습니다.' : '운동 수신 여부를 아직 확인하지 못했습니다.');
  }
  var hours = (summary.hours || []).filter(hasHourlyObservations_);
  if (hours.length) {
    lines.push('', '시간대별 흐름', '심박은 각 시간대의 15분 중앙값들을 요약한 값이며, 범위는 관측 최소–최대입니다.');
    hours.forEach(function (hour) {
      lines.push(clockTime_(hour.startMs) + '–' + clockTime_(hour.endMs) +
        ' · 심박 ' + (hour.medianHeartRate === null ? '미수신' : hour.medianHeartRate + ' (' +
          hour.minHeartRate + '–' + hour.maxHeartRate + ') bpm') +
        ' · 걸음 ' + (hour.steps === null ? '미수신' : hour.steps + '보') +
        ' · MET 2 이상 ' + (hour.activityMinutes ? hour.activeMinutes + '분' : '미수신') +
        ' · 개인 경계 초과 ' + (hour.comparedWindows ? hour.elevatedWindows + '/' + hour.comparedWindows + '구간' : '비교 보류'));
    });
  }
  if (n && (n.sleepTip || n.vitalityTip || n.exerciseTip)) {
    lines.push('', 'Polar의 제안 (원문)');
    [['수면', n.sleepTip], ['에너지', n.vitalityTip], ['운동', n.exerciseTip]].forEach(function (tip) {
      if (tip[1]) lines.push(tip[0] + ': ' + String(tip[1]).slice(0, 1500));
    });
  }
  if (summary.source === 'healine-platform') {
    lines.push('', '수집 상태 · Healine에 저장된 기록');
    var names = { heart_rate: '심박', activity: '활동·걸음', sleep: '수면', recovery: '회복', workout: '운동' };
    var reasons = { no_days: 'Polar 응답에 해당 날짜가 없음', no_samples: '날짜 기록은 있으나 상세 샘플이 없음',
      invalid_samples: '샘플의 값·시간 형식 확인 필요', unexpected_schema: '응답 구조 확인 필요',
      http_error: 'Polar 조회 실패', processing_error: '플랫폼 재처리 대기', partial: '일부 유효하지 않은 샘플 제외' };
    (summary.diagnostics || []).forEach(function (entry) {
      if (entry.code !== 'ok') lines.push((names[entry.kind] || entry.kind) + ': ' +
        (reasons[entry.code] || entry.status) + (entry.http_status ? ' (' + entry.http_status + ')' : ''));
    });
  }
  lines.push('', '출처: Polar AccessLink v4 / Nightly Recharge',
    'https://support.polar.com/en/nightly-recharge-recovery-measurement',
    calendarDataBlock_(dailyCalendarData_(summary)),
    '[healine-day:' + summary.date + ']');
  return lines.join('\n');
}

function hasHourlyObservations_(hour) {
  return hour.heartRateSampleCount > 0 || hour.steps !== null || hour.activityMinutes > 0;
}

function calendarDataBlock_(data) {
  return '\n[HEALINE_DATA_V1]\n' + JSON.stringify(data) + '\n[/HEALINE_DATA_V1]';
}

function hourlyCalendarData_(hour) {
  return {
    schema: 'healine.calendar.v1', modelVersion: HEALINE.modelVersion, kind: 'hour', timezone: HEALINE.timezone,
    provider: 'polar-accesslink-v4', storage: hour.source || 'apps-script',
    start: isoTimestamp_(hour.startMs), end: isoTimestamp_(hour.endMs),
    dataState: hasHourlyObservations_(hour) ? 'observed' : 'no_observations_in_latest_snapshot',
    nullMeaning: 'unreceived_or_not_comparable',
    minuteAggregation: 'observed_samples_grouped_by_timestamp; absent_rows_have_no_samples; no_interpolation',
    minuteColumns: ['at', 'hr_median_bpm', 'hr_min_bpm', 'hr_max_bpm', 'hr_samples',
      'steps_sample_sum', 'met_sample_mean', 'met_samples'],
    minutes: hour.windows.reduce(function (all, row) {
      return all.concat((row.minuteObservations || []).map(function (minute) {
        return [isoTimestamp_(minute[0])].concat(minute.slice(1));
      }));
    }, []),
    quarters: hour.windows.map(function (row) {
      return {
        start: isoTimestamp_(row.startMs), end: isoTimestamp_(row.endMs), heartRateObservationStatus: row.status,
        heartRate: { medianBpm: row.medianHeartRate, minBpm: row.minHeartRate, maxBpm: row.maxHeartRate,
          samples: row.heartRateSampleCount, firstAt: isoTimestamp_(row.firstHeartRateAt), lastAt: isoTimestamp_(row.lastHeartRateAt) },
        activity: { metSampleMean: row.averageMet, metMax: row.maxMet, coveredMinutes: row.metMinutes,
          metAtLeast2ObservedMinutes: row.metMinutes ? row.activeMinutes : null,
          observedSteps: row.steps, stepCoveredMinutes: row.stepMinutes,
          recent30MinMetCoverageMinutes: row.recentActivityMetMinutes,
          recent30MinMetSampleMean: row.recentAverageMet,
          recent30MinActiveMinutes: row.recentActiveMinutes,
          recentActivityObserved: row.recentActivityMetMinutes ? row.recentActivity : null },
        comparisonEligible: Boolean(row.comparisonEligible), comparisonReason: row.comparisonReason || null,
        comparison: row.baseline ? { baselineBpm: row.baseline.median, displayUpperBpm: row.baseline.upper,
          deltaBpm: row.heartRateDelta, priorDays: row.baseline.days, priorWindows: row.baseline.windows,
          referenceDates: row.baseline.dates || [], method: row.baseline.method || null,
          reference: row.baseline.source } : null
      };
    })
  };
}

function dailyCalendarData_(summary) {
  var n = summary.nightly || {}, sleep = summary.sleep;
  var rri = positiveNumber_(n.meanNightlyRecoveryRri), baselineRri = positiveNumber_(n.meanBaselineRri);
  return {
    schema: 'healine.calendar.v1', modelVersion: HEALINE.modelVersion, kind: 'day', date: summary.date, timezone: HEALINE.timezone,
    provider: 'polar-accesslink-v4', storage: summary.source || 'apps-script',
    nullMeaning: 'unreceived_or_not_comparable',
    analyzedThrough: summary.windows.length ? isoTimestamp_(summary.windows[summary.windows.length - 1].endMs) : null,
    recovery: { date: summary.nightly ? n.sleepResultDate : null, polarIndicator1To6: summary.recoveryIndicator,
      polarAnsRating1To5: validNumber_(n.ansRate), polarAnsStatus: validNumber_(n.ansStatus),
      meanRriMs: rri, baselineMeanRriMs: baselineRri,
      heartRateFromMeanRriBpm: rri ? round_(60000 / rri, 1) : null,
      baselineHeartRateFromMeanRriBpm: baselineRri ? round_(60000 / baselineRri, 1) : null,
      rmssdMs: positiveNumber_(n.meanNightlyRecoveryRmssd), baselineRmssdMs: positiveNumber_(n.meanBaselineRmssd) },
    sleep: sleep ? { start: isoTimestamp_(sleep.startMs), end: isoTimestamp_(sleep.endMs),
      intervalMinutesIncludingAwake: sleep.durationMinutes, polarScore: sleep.score,
      polarComponentScoresOutOf100: sleep.scores || null } : null,
    syncWarning: summary.syncWarning || null,
    overnightPersonalComparison: summary.nightComparison || null,
    daytimeComparison: { eligibleQuarters: summary.comparisonEligibleWindows || 0,
      comparedQuarters: summary.comparedWindows || 0, method: 'activity_context_v3' },
    sleepAccess: summary.sleepAccess || 'unknown',
    workouts: { access: summary.workoutAccess || 'unknown', count: (summary.workouts || []).length,
      ids: (summary.workouts || []).map(function (w) { return w.id; }),
      durationSeconds: (summary.workouts || []).reduce(function (sum, w) { return sum + w.durationSeconds; }, 0) },
    activity: { observedSteps: summary.steps, metCoveredMinutes: summary.activityMinutes,
      stepCoveredMinutes: summary.stepMinutes, metAtLeast2ObservedMinutes: summary.activityMinutes ? summary.activeMinutes : null },
    heartRate: { samples: summary.heartRateSampleCount, observedQuarters: summary.observedWindows,
      analyzedQuarters: summary.totalWindows, lastAt: isoTimestamp_(summary.lastHeartRateAt) },
    // Columns and units remain explicit even when this daily event is read on its own.
    hourAggregation: 'median_of_observed_quarter_medians; range_from_observed_samples',
    hourColumns: ['start', 'end', 'hr_quarter_median_bpm', 'hr_min_bpm', 'hr_max_bpm', 'hr_samples',
      'steps_sample_sum', 'met_covered_minutes', 'step_covered_minutes', 'met_at_least_2_observed_minutes',
      'compared_quarters', 'above_display_boundary_quarters'],
    hours: (summary.hours || []).filter(hasHourlyObservations_).map(function (hour) {
      return [isoTimestamp_(hour.startMs), isoTimestamp_(hour.endMs), hour.medianHeartRate,
        hour.minHeartRate, hour.maxHeartRate, hour.heartRateSampleCount, hour.steps,
        hour.activityMinutes, hour.stepMinutes, hour.activityMinutes ? hour.activeMinutes : null,
        hour.comparedWindows, hour.elevatedWindows];
    }),
    collection: (summary.diagnostics || []).map(function (entry) {
      var fetchedAt = entry.fetchedAt ? Date.parse(entry.fetchedAt) : null;
      return { kind: entry.kind, status: entry.status, code: entry.code,
        lastFetchedAt: isoTimestamp_(fetchedAt), httpStatus: entry.http_status || null };
    })
  };
}

function upsertHealineSleep_(calendar, events, sleep) {
  // A night's sleep can begin before the queried day. Look it up across the exact sleep span too.
  var sleepEvents = events.concat(calendar.getEvents(new Date(sleep.startMs), new Date(sleep.endMs)));
  return upsertManagedEvent_(calendar, sleepEvents, {
    tag: 'healineSleep', key: sleep.date, startMs: sleep.startMs, endMs: sleep.endMs,
    title: '😴 수면 구간 · ' + durationText_(sleep.durationMinutes),
    description: 'Polar가 기록한 수면 시작–종료 구간입니다. 중간 각성을 포함하므로 실제 잠든 시간과 다를 수 있습니다.\n[healine-sleep:' + sleep.date + ']',
    color: CalendarApp.EventColor.MAUVE
  });
}

function positiveNumber_(value) { var n = validNumber_(value); return n !== null && n > 0 ? n : null; }
function displayValue_(value) { return value === null || value === undefined ? '미수신' : String(value); }
function isoTimestamp_(time) { return typeof time === 'number' && Number.isFinite(time) ? new Date(time).toISOString() : null; }
function measurementRange_(first, last) {
  if (!first || !last) return '미수신';
  return formatDateTime_(new Date(first)) + '–' + formatDateTime_(new Date(last));
}
function signed_(value) { return value > 0 ? '+' + value : String(value); }
function clockTime_(time) { return Utilities.formatDate(new Date(time), HEALINE.timezone, 'HH:mm'); }
function durationText_(minutes) { return Math.floor(minutes / 60) + '시간 ' + minutes % 60 + '분'; }
