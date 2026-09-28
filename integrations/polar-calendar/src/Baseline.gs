function rebuildBaseline() {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) return null;
  try { return rebuildBaselineUnlocked_(); }
  finally { lock.releaseLock(); }
}

function rebuildBaselineUnlocked_() {
  assertHealineConfigured_();
  var today = formatIsoDate_(new Date());
  var properties = PropertiesService.getUserProperties();
  properties.setProperty(HEALINE.propertyKeys.baselineAttemptDate, today);
  var from = addIsoDays_(today, -HEALINE.baselineDays);
  var data;
  if (isHealinePlatformConnected_()) {
    data = readPlatformObservations_(from, today);
  } else {
    var activity = fetchActivityRange_(from, today);
    data = { heartRateSamples: fetchHeartRateRange_(from, today),
      metSamples: activity.metSamples, stepSamples: activity.stepSamples, sleeps: fetchSleepRange_(from, today).sleeps };
  }
  var baseline = buildBaseline_(data, from, today);
  if (!Object.keys(baseline.days).length) throw new Error('활동 맥락이 함께 있는 심박 기록이 아직 부족합니다.');
  saveBaseline_(baseline);
  console.log('개인 비교 기준 갱신: ' + Object.keys(baseline.days).length + '일');
  return baseline;
}

function buildBaseline_(data, from, to) {
  var days = {};
  evaluateHealineRange_(data, localDayStartMs_(from), localDayStartMs_(to), null).forEach(function (row) {
    if (!row.comparisonEligible) return;
    var date = dateKeyPure_(row.startMs);
    if (!days[date]) days[date] = [];
    days[date].push([seoulHourPure_(row.startMs) * 60 + new Date(row.startMs).getUTCMinutes(),
      row.medianHeartRate, row.averageMet, row.steps, row.activeMinutes, row.recentAverageMet, row.recentActiveMinutes]);
  });
  return { version: HEALINE.modelVersion, createdAt: new Date().toISOString(), from: from, to: to, days: days,
    nights: (data.nightlyRecharges || []).filter(function (n) { return n.sleepResultDate >= from && n.sleepResultDate < to; })
      .map(function (n) { return { sleepResultDate: n.sleepResultDate,
        meanNightlyRecoveryRmssd: n.meanNightlyRecoveryRmssd, meanNightlyRecoveryRri: n.meanNightlyRecoveryRri }; }) };
}

function saveBaseline_(baseline) {
  var props = PropertiesService.getUserProperties(), prefix = HEALINE.propertyKeys.baseline;
  var previous = getBaseline_(), values = {};
  Object.keys(baseline.days).forEach(function (date) {
    var json = JSON.stringify(baseline.days[date]);
    if (json.length > 8500) throw new Error('하루 기준 자료가 저장 한도를 초과했습니다.');
    values[prefix + '_' + date] = json;
  });
  var metadata = Object.assign({}, baseline, { days: Object.keys(baseline.days), splitByDay: true });
  values[prefix] = JSON.stringify(metadata);
  props.setProperties(values);
  props.deleteProperty(HEALINE.propertyKeys.baselineDirty);
  Object.keys(previous && previous.days || {}).forEach(function (date) {
    if (!baseline.days[date]) props.deleteProperty(prefix + '_' + date);
  });
}

function getBaseline_() {
  var props = PropertiesService.getUserProperties(), prefix = HEALINE.propertyKeys.baseline;
  var raw = props.getProperty(prefix);
  if (!raw) return null;
  try {
    var baseline = JSON.parse(raw);
    if (baseline.splitByDay) {
      var days = {};
      baseline.days.forEach(function (date) {
        var rawDay = props.getProperty(prefix + '_' + date);
        if (rawDay) days[date] = JSON.parse(rawDay);
      });
      baseline.days = days;
    }
    return baseline;
  } catch (error) { console.warn('저장된 기준 데이터를 읽지 못했습니다.'); return null; }
}
