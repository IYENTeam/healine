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
  if (spec.notes) {
    var marker = '\n\n[내 메모]\n';
    var previous = event ? event.getDescription() : '';
    var markerIndex = previous.indexOf(marker);
    spec.description += marker + (markerIndex >= 0
      ? previous.slice(markerIndex + marker.length) : '몸 상태·카페인·운동·업무 상황을 적어두면 기록과 비교할 수 있습니다.');
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
    title: hourlyTitle_(hour), description: hourlyDescription_(hour),
    color: hour.elevatedMinutes >= 30 ? CalendarApp.EventColor.ORANGE :
      hour.activeMinutes > 0 || hour.steps >= 100 ? CalendarApp.EventColor.BLUE : CalendarApp.EventColor.GRAY
  });
}

function hourlyTitle_(hour) {
  var title = hour.elevatedMinutes >= 30 ? '🫀 낮은 활동에 심박 ↑' :
    hour.activeMinutes > 0 || hour.steps >= 100 ? '🚶 활동 기록' : '🫀 심박 기록';
  if (hour.medianHeartRate !== null) title += ' · ' + hour.medianHeartRate + ' bpm';
  if (hour.steps !== null && hour.steps > 0) title += ' · ' + hour.steps + '보';
  return title;
}

function hourlyDescription_(hour) {
  var lines = ['Healine · 시간대별 관측', '아래 수치는 기록된 구간의 값이며 스트레스 점수가 아닙니다.', ''];
  if (hour.elevatedMinutes >= 30) {
    lines.push('움직임이 적게 기록된 15분 구간 ' + hour.elevatedMinutes / 15 + '개에서 연속으로 개인 비교 기준을 넘었습니다.');
    lines.push('당시의 운동·카페인·몸 상태·일정을 함께 확인하고, 여유가 생기면 잠깐 쉬며 현재 느낌과 비교해 보세요.', '');
  }
  var labels = {
    NO_DATA: '심박 미수신', PARTIAL: '심박 또는 활동 기록 부족', ACTIVE: '활동 기록 있음',
    AFTER_ACTIVITY: '최근 30분에 활동 기록 있음', OBSERVED: '관측값', SLEEP_RECORDED: 'Polar 수면 기록과 겹치는 구간',
    NIGHT_OBSERVATION: '야간 · 개인 심박 비교 보류',
    LOW_MOVEMENT: '낮은 활동 기록', BUILDING_BASELINE: '개인 비교 기준 누적 중', ABOVE_USUAL: '개인 비교 기준보다 높음'
  };
  hour.windows.forEach(function (row) {
    var line = clockTime_(row.startMs) + '–' + clockTime_(row.endMs) + ' · ' + labels[row.status];
    if (row.medianHeartRate !== null) line += ' · 심박 중앙값 ' + row.medianHeartRate + ' bpm';
    lines.push(line);
    if (row.baseline) lines.push('  같은 시간대 ' + row.baseline.days + '일 기준 ' + row.baseline.median +
      ' bpm / 차이 ' + signed_(row.heartRateDelta) + ' bpm / 표시 경계 ' + row.baseline.upper + ' bpm');
    lines.push('  심박 ' + row.heartRateSampleCount + '개 · 활동 기록 ' + row.metMinutes + '/15분 · 걸음 ' +
      (row.steps === null ? '미수신' : row.steps + '보'));
  });
  lines.push('', '심박만으로 긴장·감정·질환의 원인을 구분하지 않습니다. 수면 회복 수치는 낮 심박에 가산하지 않습니다.',
    '[healine-hour:' + hourKey_(hour.startMs) + ']');
  return lines.join('\n');
}

function upsertHealineDay_(calendar, events, summary) {
  var title = '🌿 회복 ' + summary.recoveryLabel;
  if (summary.sleep) title += ' · 수면 구간 ' + durationText_(summary.sleep.durationMinutes);
  if (summary.steps !== null) title += ' · 관측 ' + summary.steps + '보';
  return upsertManagedEvent_(calendar, events, {
    tag: 'healineDay', key: summary.date, allDay: true, startMs: localDayStartMs_(summary.date),
    title: title, description: dailyDescription_(summary), notes: true,
    color: summary.recoveryIndicator === null ? CalendarApp.EventColor.GRAY :
      summary.recoveryIndicator <= 3 ? CalendarApp.EventColor.ORANGE : CalendarApp.EventColor.GREEN
  });
}

function dailyDescription_(summary) {
  var lines = ['Healine · ' + summary.date + ' 하루 요약', '', '오늘 참고할 점', summary.guidance, '', '밤사이 회복'];
  var n = summary.nightly;
  lines.push('Polar Nightly Recharge: ' + summary.recoveryLabel + (n ? ' (' + n.sleepResultDate + ')' : ''));
  if (n) {
    var rri = positiveNumber_(n.meanNightlyRecoveryRri);
    var baselineRri = positiveNumber_(n.meanBaselineRri);
    var hrv = positiveNumber_(n.meanNightlyRecoveryRmssd);
    var baselineHrv = positiveNumber_(n.meanBaselineRmssd);
    if (rri) lines.push('야간 심박(평균 박동 간격 환산): ' + round_(60000 / rri, 1) + ' bpm' +
      (baselineRri ? ' · 평소 ' + round_(60000 / baselineRri, 1) + ' bpm' : ''));
    if (hrv) lines.push('야간 HRV(RMSSD): ' + hrv + ' ms' +
      (baselineHrv ? ' · 평소 ' + baselineHrv + ' ms (' + signed_(Math.round((hrv / baselineHrv - 1) * 100)) + '%)' : ''));
    if (rri || hrv) lines.push('야간 지표는 수면 초반의 측정값입니다. 낮 시간 스트레스 측정값이 아닙니다.');
  }
  if (summary.sleep) {
    lines.push('수면 구간: ' + clockTime_(summary.sleep.startMs) + '–' + clockTime_(summary.sleep.endMs) +
      ' (' + durationText_(summary.sleep.durationMinutes) + ', 중간 각성 포함)');
    if (summary.sleep.score !== null) lines.push('Polar 수면 점수: ' + summary.sleep.score + '/100');
  } else {
    lines.push('수면 시간: ' + (summary.sleepAccess === 'needs_connection'
      ? '추가 연결 필요. Healine 설정 화면에서 Polar를 다시 연결하면 수면 읽기가 추가됩니다.'
      : summary.sleepAccess === 'error' ? '조회 실패, 다음 실행에서 다시 확인합니다.' : '아직 미수신'));
  }
  lines.push('', '활동과 기록 범위', '관측된 걸음: ' + (summary.steps === null ? '미수신' : summary.steps + '보'),
    'MET 2 이상으로 기록된 시간: ' + (summary.activityMinutes ? summary.activeMinutes + '분' : '미수신'),
    '활동 데이터가 있는 시간: ' + summary.activityMinutes + '분',
    '심박 기록이 있는 15분 구간: ' + summary.observedWindows + '/' + summary.totalWindows + '개',
    '마지막 심박 시각: ' + (summary.lastHeartRateAt ? formatDateTime_(new Date(summary.lastHeartRateAt)) : '미수신'),
    '빈 구간은 휴식이나 0걸음으로 계산하지 않습니다. Flow 동기화 후 오늘·어제 기록을 다시 반영합니다.');
  if (n && (n.sleepTip || n.vitalityTip || n.exerciseTip)) {
    lines.push('', 'Polar의 제안 (원문)');
    [['수면', n.sleepTip], ['에너지', n.vitalityTip], ['운동', n.exerciseTip]].forEach(function (tip) {
      if (tip[1]) lines.push(tip[0] + ': ' + String(tip[1]).slice(0, 1500));
    });
  }
  if (summary.source === 'healine-platform') {
    lines.push('', '수집 상태 · Healine에 저장된 기록');
    var names = { heart_rate: '심박', activity: '활동·걸음', sleep: '수면', recovery: '회복' };
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
    '[healine-day:' + summary.date + ']');
  return lines.join('\n');
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

function cleanupLegacyHealineEvents_(events, writtenHours, limit) {
  var removed = 0;
  events.slice().sort(function (a, b) { return b.getStartTime() - a.getStartTime(); }).forEach(function (event) {
    if (removed >= limit || event.getTag('healineHour') || event.getTag('healineDay') || event.getTag('healineSleep')) return;
    var key = event.getTag(HEALINE.eventTag);
    // Only known automation records with both identifiers can be retired.
    if (!key || !/^\d{8}-\d{4}$/.test(key) || event.getDescription().indexOf('[healine:' + key + ']') < 0) return;
    // Preserve legacy records carrying extra user notes or a modified description.
    var lines = event.getDescription().split('\n');
    if (lines[0] !== 'Healine 실험용 생리 상태 추정' || lines[lines.length - 1] !== '[healine:' + key + ']') return;
    var knownLine = /^(Healine 실험용 생리 상태 추정|구간:|상태:|긴장도 점수:|중앙 심박수:|기준 심박수:|기준 대비:|평균 MET:|걸음 수:|심박 샘플:|구간 종료 대비 데이터 지연:|Nightly Recharge 회복 단계:|신뢰도:|심박·활동량 기반 참고 지표이며 정신적 스트레스나 질환을 진단하지 않습니다\.|\[healine:|$)/;
    if (!lines.every(function (line) { return knownLine.test(line); })) return;
    if (!writtenHours[hourKey_(event.getStartTime().getTime())]) return;
    event.deleteEvent(); removed += 1;
  });
  return removed;
}

function positiveNumber_(value) { var n = validNumber_(value); return n !== null && n > 0 ? n : null; }
function signed_(value) { return value > 0 ? '+' + value : String(value); }
function clockTime_(time) { return Utilities.formatDate(new Date(time), HEALINE.timezone, 'HH:mm'); }
function durationText_(minutes) { return Math.floor(minutes / 60) + '시간 ' + minutes % 60 + '분'; }
