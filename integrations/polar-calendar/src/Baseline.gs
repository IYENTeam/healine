function rebuildBaseline() {
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
      metSamples: activity.metSamples, stepSamples: activity.stepSamples };
  }
  var baseline = buildBaseline_(data, from, today);
  if (!Object.keys(baseline.days).length) throw new Error('활동 맥락이 함께 있는 심박 기록이 아직 부족합니다.');
  var json = JSON.stringify(baseline);
  if (json.length > 8500) throw new Error('기준 데이터가 저장 한도를 초과했습니다.');
  properties.setProperty(HEALINE.propertyKeys.baseline, json);
  console.log('개인 비교 기준 갱신: ' + Object.keys(baseline.days).length + '일');
  return baseline;
}

function buildBaseline_(data, from, to) {
  var groups = {};
  // Index once; rebuilding fourteen days must not scan all samples for every window.
  var buckets = {};
  ['heartRateSamples', 'metSamples', 'stepSamples'].forEach(function (kind) {
    (data[kind] || []).forEach(function (sample) {
      var key = Math.floor(sample.timestampMs / 900000) * 900000;
      if (!buckets[key]) buckets[key] = { heartRateSamples: [], metSamples: [], stepSamples: [] };
      buckets[key][kind].push(sample);
    });
  });
  Object.keys(buckets).sort().forEach(function (key) {
    var start = Number(key), date = dateKeyPure_(start), bucket = buckets[key];
    if (date < from || date >= to) return;
    var previousMets = [];
    [start - 1800000, start - 900000].forEach(function (earlier) {
      if (buckets[earlier]) previousMets = previousMets.concat(buckets[earlier].metSamples);
    });
    var result = evaluateHealineWindow_({
      windowStartMs: start, windowEndMs: start + 900000,
      heartRateSamples: bucket.heartRateSamples,
      metSamples: previousMets.concat(bucket.metSamples), stepSamples: bucket.stepSamples
    });
    if (!result.isQuiet) return;
    var hour = seoulHourPure_(start);
    if (!groups[date]) groups[date] = {};
    if (!groups[date][hour]) groups[date][hour] = [];
    groups[date][hour].push(result.medianHeartRate);
  });
  var days = {};
  Object.keys(groups).sort().forEach(function (date) {
    days[date] = Object.keys(groups[date]).map(function (hour) {
      var values = groups[date][hour];
      return [Number(hour), round_(median_(values), 1), values.length];
    });
  });
  return { version: 2, createdAt: new Date().toISOString(), from: from, to: to, days: days };
}

function getBaseline_() {
  var raw = PropertiesService.getUserProperties().getProperty(HEALINE.propertyKeys.baseline);
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (error) { console.warn('저장된 기준 데이터를 읽지 못했습니다.'); return null; }
}
