const assert = require('node:assert/strict');
const test = require('node:test');
const { load } = require('./helpers');
const { context: c } = load();
const start = Date.parse('2026-09-17T14:00:00+09:00');
function baseline() {
  return { version: 3, days: Object.fromEntries(Array.from({length: 7}, (_, i) =>
    ['2026-09-' + (10 + i), [0,15,30,45].map(m => [840+m, 66+i%2, 1.2, 0, 0, 1.2, 0])])) };
}
function input(overrides = {}) {
  return {
    windowStartMs: start, windowEndMs: start + 900000,
    heartRateSamples: [1, 6, 11].map(m => ({timestampMs: start + m * 60000, heartRate: 66})),
    metSamples: Array.from({length: 45}, (_, i) => ({timestampMs: start + (i - 30) * 60000, met: 1.2})),
    stepSamples: Array.from({length:15}, (_,i)=>({timestampMs:start+i*60000,steps:0})), baseline: baseline(), ...overrides
  };
}
test('observations have no invented stress score or confidence percentage', () => {
  const r = c.evaluateHealineWindow_(input());
  assert.equal(r.status, 'CONTEXT_MATCHED');
  assert.equal(r.baseline.days, 7);
  assert.equal(r.steps, 0);
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
test('substantially different recent activity and known sleep cannot use a resting reference', () => {
  const data = input();
  data.metSamples.slice(0,30).forEach(s=>s.met=4);
  assert.equal(c.evaluateHealineWindow_(data).baseline, null);
  assert.equal(c.evaluateHealineWindow_(input({sleeps: [{startMs: start - 3600000, endMs: start + 3600000}]})).status, 'SLEEP_RECORDED');
});
test('a single high MET sample counts one recorded minute, not a whole quarter hour', () => {
  const r = c.evaluateHealineWindow_(input({metSamples: [{timestampMs: start, met: 3}]}));
  const day = c.buildDailySummary_('2026-09-17', [r], {});
  assert.equal(day.activeMinutes, 1);
});
test('same-day and future measurements cannot leak into the personal baseline', () => {
  const b = baseline();
  b.days['2026-09-17'] = [[840, 200, 1.2, 0, 0, 1.2, 0]];
  b.days['2026-09-18'] = [[840, 210, 1.2, 0, 0, 1.2, 0]];
  const resolved = c.resolveBaseline_(b, start, c.evaluateHealineWindow_(input({baseline:null})));
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
  assert.equal(c.resolveBaseline_(b, start, c.evaluateHealineWindow_(input({baseline:null}))), null);
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
test('baseline stores activity features in per-day properties and reloads losslessly', () => {
  const data = {heartRateSamples: [], metSamples: [], stepSamples: []};
  for (let d = 10; d <= 16; d++) {
    const t = Date.parse(`2026-09-${d}T13:30:00+09:00`);
    for (let m = 0; m < 90; m++) { data.metSamples.push({timestampMs:t+m*60000,met:1.1}); data.stepSamples.push({timestampMs:t+m*60000,steps:0}); }
    for (let m = 0; m < 90; m+=5) data.heartRateSamples.push({timestampMs:t+m*60000,heartRate:66});
  }
  const b = c.buildBaseline_(data, '2026-09-10', '2026-09-17');
  assert.equal(Object.keys(b.days).length, 7);
  assert.equal(c.resolveBaseline_(b, start, c.evaluateHealineWindow_(input({baseline:null}))).median, 66);
  c.saveBaseline_(b);
  assert.equal(JSON.stringify(c.getBaseline_().days),JSON.stringify(b.days));
  assert.ok(Object.values(b.days).every(day=>JSON.stringify(day).length < 8500));
});

test('nighttime observations do not turn sleeping heart rates into a daytime reference', () => {
  const shift=10*3600000;
  const data=input();
  data.windowStartMs-=shift;data.windowEndMs-=shift;
  data.heartRateSamples.forEach(s=>s.timestampMs-=shift);
  data.metSamples.forEach(s=>s.timestampMs-=shift);
  data.stepSamples.forEach(s=>s.timestampMs-=shift);
  assert.equal(c.evaluateHealineWindow_(data).status,'NIGHT_OBSERVATION');
  assert.equal(c.evaluateHealineWindow_(data).isQuiet,false);
});

test('minute exports retain sample extrema and zero steps without filling gaps or double counting', () => {
  const r = c.evaluateHealineWindow_(input({
    heartRateSamples: [
      {timestampMs:start+10000,heartRate:60}, {timestampMs:start+40000,heartRate:100},
      {timestampMs:start+40000,heartRate:100}, {timestampMs:start+121000,heartRate:80},
      {timestampMs:start+900000,heartRate:200}, {timestampMs:start+180000,heartRate:null}
    ],
    metSamples: [{timestampMs:start,met:1.1}],
    stepSamples: [{timestampMs:start,steps:0}, {timestampMs:start,steps:0}]
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(r.minuteObservations)), [
    [start,80,60,100,2,0,1.1,1], [start+120000,80,80,80,1,null,null,0]
  ]);
  assert.equal(r.heartRateSampleCount,3);
  assert.equal(r.firstHeartRateAt,start+10000);
  assert.equal(r.lastHeartRateAt,start+121000);
  assert.equal(r.stepMinutes,1);
  assert.equal(r.maxMet,1.1);
});

test('missing step context and missing recent activity cannot establish a comparison', () => {
  assert.equal(c.evaluateHealineWindow_(input({stepSamples:[]})).baseline,null);
  const recentMissing=input();recentMissing.metSamples=recentMissing.metSamples.filter(s=>s.timestampMs>=start);
  assert.equal(c.evaluateHealineWindow_(recentMissing).comparisonReason,'recent_activity_coverage');
});

test('recent movement can match the same movement context but never a dissimilar context', () => {
  const data=input();data.metSamples.slice(0,10).forEach(s=>s.met=3);
  assert.equal(c.evaluateHealineWindow_(data).baseline,null);
  Object.values(data.baseline.days).forEach(rows=>rows.forEach(r=>{r[5]=1.8;r[6]=10;}));
  const result=c.evaluateHealineWindow_(data);
  assert.equal(result.status,'CONTEXT_MATCHED');assert.equal(result.recentActivity,true);
  assert.equal(result.baseline.days,7);
});

test('known daytime sleep is excluded when rebuilding reference data', () => {
  const data=input();
  const from='2026-09-17',to='2026-09-18';
  data.sleeps=[{startMs:start-60000,endMs:start+900000}];
  const b=c.buildBaseline_(data,from,to);
  assert.equal(Object.keys(b.days).length,0);
});

test('overnight personal reference excludes same-day and future nights and does not invent a baseline', () => {
  const history=Array.from({length:7},(_,i)=>({sleepResultDate:'2026-09-'+(10+i),meanNightlyRecoveryRmssd:40,meanNightlyRecoveryRri:1000}));
  const current={sleepResultDate:'2026-09-17',meanNightlyRecoveryRmssd:30,meanNightlyRecoveryRri:900};
  history.push(current,{sleepResultDate:'2026-09-18',meanNightlyRecoveryRmssd:500,meanNightlyRecoveryRri:300});
  const r=c.compareNightlyHistory_('2026-09-17',current,history);
  assert.equal(r.nights,7);assert.equal(r.rmssdChangePercent,-25);assert.equal(r.heartRateChangeBpm,6.7);
  assert.equal(c.compareNightlyHistory_('2026-09-17',current,history.slice(0,2)),null);
});
