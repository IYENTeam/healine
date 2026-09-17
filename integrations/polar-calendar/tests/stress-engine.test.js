const assert = require('node:assert/strict');
const test = require('node:test');
const { load } = require('./helpers');
const { context: c } = load();
const start = Date.parse('2026-09-17T14:00:00+09:00');
function baseline() {
  return { version: 2, days: Object.fromEntries(Array.from({length: 7}, (_, i) =>
    ['2026-09-' + (10 + i), [[14, 66 + i % 2, 4]]])) };
}
function input(overrides = {}) {
  return {
    windowStartMs: start, windowEndMs: start + 900000,
    heartRateSamples: [1, 6, 11].map(m => ({timestampMs: start + m * 60000, heartRate: 66})),
    metSamples: Array.from({length: 45}, (_, i) => ({timestampMs: start + (i - 30) * 60000, met: 1.2})),
    stepSamples: [], baseline: baseline(), ...overrides
  };
}
test('observations have no invented stress score or confidence percentage', () => {
  const r = c.evaluateHealineWindow_(input());
  assert.equal(r.status, 'LOW_MOVEMENT');
  assert.equal(r.baseline.days, 7);
  assert.equal(r.steps, null);
  assert.equal('score' in r, false);
  assert.equal('confidence' in r, false);
});
test('nightly recovery cannot change daytime heart rate classification', () => {
  const a = c.evaluateHealineWindow_(input({nightlyRecharge: {recoveryIndicator: 1}}));
  const b = c.evaluateHealineWindow_(input({nightlyRecharge: {recoveryIndicator: 6}}));
  assert.deepEqual(a, b);
});
test('higher HR is described only relative to adequate prior quiet observations', () => {
  const r = c.evaluateHealineWindow_(input({heartRateSamples: [1, 6, 11].map(m => ({timestampMs: start + m * 60000, heartRate: 84}))}));
  assert.equal(r.status, 'ABOVE_USUAL');
  assert.equal(r.heartRateDelta, 18);
});
test('missing or sparse movement context never means resting or calm', () => {
  for (const metSamples of [[], [{timestampMs: start, met: 1.1}]]) {
    const r = c.evaluateHealineWindow_(input({metSamples}));
    assert.equal(r.status, 'PARTIAL');
    assert.equal(r.baseline, null);
  }
});
test('null, blank, sentinel and duplicate heart rate data cannot establish confidence', () => {
  const r = c.evaluateHealineWindow_(input({heartRateSamples: [null, '', ' ', 0, 255, 65, 65].map(v => ({timestampMs: start, heartRate: v}))}));
  assert.equal(r.heartRateSampleCount, 1);
  assert.equal(r.status, 'PARTIAL');
});
test('recent exercise and known sleep suppress comparison', () => {
  const data = input();
  data.metSamples[10].met = 4;
  assert.equal(c.evaluateHealineWindow_(data).status, 'AFTER_ACTIVITY');
  assert.equal(c.evaluateHealineWindow_(input({sleeps: [{startMs: start - 3600000, endMs: start + 3600000}]})).status, 'SLEEP_RECORDED');
});
test('a single high MET sample counts one recorded minute, not a whole quarter hour', () => {
  const r = c.evaluateHealineWindow_(input({metSamples: [{timestampMs: start, met: 3}]}));
  const day = c.buildDailySummary_('2026-09-17', [r], {});
  assert.equal(day.activeMinutes, 1);
});
test('same-day and future measurements cannot leak into the personal baseline', () => {
  const b = baseline();
  b.days['2026-09-17'] = [[14, 200, 40]];
  b.days['2026-09-18'] = [[14, 210, 40]];
  const resolved = c.resolveBaseline_(b, start);
  assert.equal(resolved.median, 66);
  assert.equal(resolved.days, 7);
});
test('old baselines and a few samples never fall back to a made-up resting HR', () => {
  for (const b of [null, {global: 60, hours: {14: 60}}, {version: 2, days: {'2026-09-16': [[14, 60, 12]]}}]) {
    assert.equal(c.evaluateHealineWindow_(input({baseline: b, fallbackRestingHeartRate: 60})).status, 'BUILDING_BASELINE');
  }
});
test('outdated baseline does not silently remain usable', () => {
  const b = {version: 2, days: Object.fromEntries([1,2,3,4,5].map(n => ['2026-09-0'+n, [[14,66,4]]]))};
  assert.equal(c.resolveBaseline_(b, start), null);
});
test('recovery belongs to the matching date, missing is not zero', () => {
  const day = c.buildDailySummary_('2026-09-17', [], {nightlyRecharges: [{sleepResultDate: '2026-09-16', recoveryIndicator: 1}]});
  assert.equal(day.nightly, null);
  assert.equal(day.recoveryIndicator, null);
  assert.equal(day.steps, null);
});
test('separated high windows do not produce a sustained elevation message', () => {
  const rows = ['ABOVE_USUAL', 'PARTIAL', 'ABOVE_USUAL', 'LOW_MOVEMENT'].map((status, i) =>
    ({...c.evaluateHealineWindow_(input()), status, startMs: start + i*900000, endMs: start+(i+1)*900000}));
  const hour = c.buildHourlyObservations_(rows)[0];
  assert.equal(hour.elevatedMinutes, 15);
  assert.ok(!c.hourlyTitle_(hour).includes('↑'));
});
test('baseline is stored as per-day hourly medians with bounded property size', () => {
  const data = {heartRateSamples: [], metSamples: [], stepSamples: []};
  for (let d = 10; d <= 16; d++) {
    const t = Date.parse(`2026-09-${d}T13:30:00+09:00`);
    for (let m = 0; m < 90; m++) data.metSamples.push({timestampMs:t+m*60000,met:1.1});
    for (let m = 0; m < 90; m+=5) data.heartRateSamples.push({timestampMs:t+m*60000,heartRate:66});
  }
  const b = c.buildBaseline_(data, '2026-09-10', '2026-09-17');
  assert.equal(Object.keys(b.days).length, 7);
  assert.equal(c.resolveBaseline_(b, start).median, 66);
  assert.ok(JSON.stringify(b).length < 8500);
});

test('nighttime observations do not turn sleeping heart rates into a daytime reference', () => {
  const shift=10*3600000;
  const data=input();
  data.windowStartMs-=shift;data.windowEndMs-=shift;
  data.heartRateSamples.forEach(s=>s.timestampMs-=shift);
  data.metSamples.forEach(s=>s.timestampMs-=shift);
  assert.equal(c.evaluateHealineWindow_(data).status,'NIGHT_OBSERVATION');
  assert.equal(c.evaluateHealineWindow_(data).isQuiet,false);
});
