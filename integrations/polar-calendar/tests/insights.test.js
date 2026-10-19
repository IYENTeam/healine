const assert = require('node:assert/strict');
const test = require('node:test');
const { load } = require('./helpers');

const COLORS = { CalendarApp: { EventColor: { GREEN: '10', GRAY: '8', BLUE: '9', ORANGE: '6', MAUVE: '3' },
  EventTransparency: { TRANSPARENT: 'transparent' } } };

class Event {
  constructor(title, start, end, description) { Object.assign(this, { title, start, end, description, tags: {} }); }
  getTag(k) { return this.tags[k] || ''; }
  getId() { return 'event-' + (this.tags.healineWorkout || this.tags.healineDay || this.title); }
  setTag(k, v) { this.tags[k] = v; }
  getTitle() { return this.title; }
  setTitle(v) { this.title = v; }
  getDescription() { return this.description; }
  setDescription(v) { this.description = v; }
  getStartTime() { return this.start; }
  getEndTime() { return this.end; }
  setTime(a, b) { this.start = a; this.end = b; }
  setColor() {}
  removeAllReminders() {}
  setTransparency() {}
}

function calendarFixture() {
  const saved = [];
  return { saved, calendar: {
    getEventById(id) { return saved.find(e => e.getId() === id) || null; },
    getEvents(a, b) { return saved.filter(e => e.start < b && e.end > a); },
    createEvent(t, a, b, o) { const e = new Event(t, a, b, o.description); saved.push(e); return e; },
    createAllDayEvent(t, a, o) { return this.createEvent(t, a, new Date(a.getTime() + 86400000), o); }
  } };
}

function paired(extra = {}) {
  const result = load({ ...COLORS, ...extra });
  result.properties.setProperties({
    HEALINE_PLATFORM_URL: 'https://healine.example.com',
    HEALINE_PLATFORM_COLLECTOR_KEY: 'test-collector-key'
  });
  return result;
}

function calendarData(description) {
  return JSON.parse(description.split('[HEALINE_DATA_V1]\n')[1].split('\n[/HEALINE_DATA_V1]')[0]);
}

function withNote(event, note) {
  event.description = event.description.split('\n\n[내 메모]\n')[0] + '\n\n[내 메모]\n' + note;
}

test('added measurements are requested only with their granted scope and never block core completion', () => {
  const { context: c, properties } = paired();
  properties.setProperty('POLAR_GRANTED_SCOPES',
    'continuous_samples:read activity:read nightly_recharge:read sleep:read skin_contact:read ppi_data:read');
  c.getValidPolarAccessToken_ = () => 'token';
  const urls = [], batches = [];
  c.fetchPolarWithToken_ = url => {
    urls.push(url);
    if (url.includes('/skin-contacts') && !url.includes('T00%3A00%3A00')) {
      return { getResponseCode: () => 400, getContentText: () => '{"error":"Value for key \'from\' could not be parsed as datetime"}' };
    }
    if (url.includes('/ppi-samples')) {
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ dailyPpiSamples: [{ date: '2026-09-17',
        ppiSamplesPerDevice: [{ recordingDevice: { id: 'watch' }, ppiSamples: [
          { offsetMillis: 1000, ppInterval: 1000, errorEstimateMillis: 5, skinContact: true, movement: false, offline: false },
          { offsetMillis: 2010, ppInterval: 1010, errorEstimateMillis: 5, skinContact: true, movement: true, offline: true }
        ] }] }] }) };
    }
    return { getResponseCode: () => 200, getContentText: () => '{}' };
  };
  // Deliveries are serialized JSON, so compare what would cross the wire.
  c.platformRequest_ = (_path, payload) => { batches.push(JSON.parse(JSON.stringify(payload)));
    return { status: payload.kind === 'ppi' ? 'parse_error' : 'empty' }; };
  assert.equal(c.syncPlatformRange_('2026-09-17', '2026-09-18').complete, true);
  assert.deepEqual(batches.map(b => b.kind), ['heart_rate', 'activity', 'sleep', 'recovery', 'skin_contact', 'ppi']);
  assert.ok(!urls.some(u => u.includes('/tests/list') || u.includes('/temperature-measurements')));
  const skin = urls.filter(u => u.includes('/skin-contacts')).map(u => new URL(u).searchParams.get('from'));
  assert.deepEqual(skin, ['2026-09-17', '2026-09-17T00:00:00']);
  const columns = batches[5].payload.healinePpiColumns.days[0].devices[0];
  assert.deepEqual(columns.offsetMillis, [1000, 2010]);
  assert.deepEqual(columns.flags, [1, 7]);
  assert.deepEqual(columns.recordingDevice, { id: 'watch' });
  assert.deepEqual(Array.from(c.missingExtendedScopes_()), ['tests:read', 'temperature_measurement:read']);
});

test('the extended connection page requests added scopes while the default keeps the original set', () => {
  const { context: c } = load({ ...COLORS,
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.example/exec' }) },
    HtmlService: { createHtmlOutput: html => html },
    Utilities: { getUuid: () => 'state', formatDate() { return ''; } }
  });
  c.assertHealineConfigured_ = () => ({ clientId: 'client', redirectUri: 'https://auth.example/callback' });
  const scope = url => new URL(url).searchParams.get('scope').split(' ');
  assert.ok(!scope(c.getPolarAuthorizationUrl(false)).includes('ppi_data:read'));
  assert.ok(scope(c.getPolarAuthorizationUrl(true)).includes('temperature_measurement:read'));
  assert.ok(c.renderPolarConnectPage_(false).includes('https://script.example/exec?extended=1'));
});

test('missing sports scope is recorded in the retained workout response', () => {
  const { context: c, properties } = paired();
  properties.setProperty('POLAR_GRANTED_SCOPES', 'training_sessions:read');
  const body = c.enrichWorkoutSports_({ trainingSessions: [{ sport: { id: '15' } }] });
  assert.equal(body.healineSportCatalogStatus, 'no_scope');
});

test('a compacted daily card keeps the training lines when they still fit', () => {
  const { context: c } = paired();
  const { calendar, saved } = calendarFixture();
  const summary = c.buildDailySummary_('2026-09-17', [], { training: [{ date: '2026-09-17', sessions7: 2, durationSeconds7: 3600,
    cardioLoad7: 50, workoutCollectionCoveredDays7: 7, workoutCollectionCoveredDays28: 28, cardioLoad28WeeklyAverage: 40,
    acuteToWeeklyAverageRatio: 1.25, heartRateZones7: [],
    nightRmssdChange28: { afterWorkout: { nights: 0, medianPercent: null }, withoutWorkout: { nights: 0, medianPercent: null } } }] });
  c.dailyDescription_ = () => 'x'.repeat(8100);
  c.upsertHealineDay_(calendar, [], summary);
  assert.ok(saved[0].description.length <= 8000);
  assert.ok(saved[0].description.includes('최근 7일은 주평균의 1.25배'));
  assert.equal(calendarData(saved[0].description).training.cardioLoad7, 50);
});

test('sport catalog accepts an unwrapped list and plain string identifiers', () => {
  const { context: c } = paired({ CacheService: { getScriptCache: () => ({ get: () => null, put() { throw new Error('too large'); } }) } });
  c.polarGet_ = () => ({ data: [{ id: '15', name: 'OTHER_OUTDOOR', parentSport: '15',
    localizedNames: { ko: { longName: '기타 야외' } } }] });
  const body = c.enrichWorkoutSports_({ trainingSessions: [{ sport: { id: '15' } }] });
  assert.equal(body.healineSportCatalogStatus, 'ok');
  assert.equal(body.healineSportCatalog['15'].label, '기타 야외');
  c.polarGet_ = () => ({ items: [] });
  const unknown = c.enrichWorkoutSports_({ trainingSessions: [{ sport: { id: '15' } }] });
  assert.match(unknown.healineSportCatalogStatus, /keys: items/);
});

test('note check-ins require their own line and ignore the generated hint', () => {
  const { context: c } = paired();
  assert.equal(c.parseMemoCheckin_('언덕 훈련\nRPE 7', 'workout_rpe'), 7);
  assert.equal(c.parseMemoCheckin_('체감: 10', 'workout_rpe'), 10);
  assert.equal(c.parseMemoCheckin_('rpe 11', 'workout_rpe'), null);
  assert.equal(c.parseMemoCheckin_('컨디션 3', 'day_condition'), 3);
  assert.equal(c.parseMemoCheckin_('컨디션 6', 'day_condition'), null);
  const hint = '숫자 기록: 다음 줄에 "컨디션 3"처럼 1~5로 적으면 체감 컨디션으로 저장합니다.';
  assert.equal(c.parseMemoCheckin_(hint, 'day_condition'), null);
  assert.equal(c.parseMemoCheckin_('숫자 기록: 다음 줄에 "RPE 7"처럼', 'workout_rpe'), null);
});

test('workout check-in, next-night response and training context reach the calendar and the platform', () => {
  const { context: c } = paired();
  const { calendar, saved } = calendarFixture();
  c.getOrCreateHealineCalendar_ = () => calendar;
  const posted = [];
  c.platformRequest_ = (path, payload) => { posted.push(JSON.parse(JSON.stringify(payload))); return { status: 'processed' }; };
  const range = { start: new Date('2026-09-17T00:00:00+09:00'), end: new Date('2026-09-18T00:00:00+09:00') };
  const workout = () => ({ id: 'w1', name: 'Run', sport: { id: '15', name: 'OTHER', label: '종목 미확인 (Polar ID 15)', catalogResolved: false },
    startMs: Date.parse('2026-09-17T19:00:00+09:00'), endMs: Date.parse('2026-09-17T20:00:00+09:00'),
    durationSeconds: 3600, elapsedSeconds: 3600, distanceMeters: null, energyKcal: 400, heartRateAvgBpm: 120,
    heartRateMaxBpm: 150, trainingLoad: { cardioLoad: 30, sessionRpe: 'RPE_EASY' }, feeling: 0.4, exercises: [] });
  const data = () => ({ source: 'healine-platform', workoutAccess: 'granted', workouts: [workout()], checkins: [],
    workoutResponses: { w1: { night: '2026-09-18', matchedBy: 'sleep_record', sharedWithWorkouts: [],
      comparison: { rmssdMs: 30, rmssdChangePercent: -25, heartRateFromRriBpm: 64, heartRateChangeBpm: 4, ansRate: 2, referenceNights: 8 } } },
    training: [{ date: '2026-09-17', sessions7: 3, durationSeconds7: 9000, cardioLoad7: 85.5, workoutCollectionCoveredDays7: 7,
      workoutCollectionCoveredDays28: 20, cardioLoad28WeeklyAverage: null, acuteToWeeklyAverageRatio: null,
      heartRateZones7: [{ lowerBpm: 96, upperBpm: 115, seconds: 1800 }],
      nightRmssdChange28: { afterWorkout: { nights: 4, medianPercent: -8.5 }, withoutWorkout: { nights: 2, medianPercent: null } } }],
    temperatureNights: [{ date: '2026-09-17', status: 'measured', medianCelsius: 34.1, samples: 300, referenceNights: 6,
      deviationCelsius: 0.4 }],
    skinContacts: [{ startMs: Date.parse('2026-09-17T09:00:00+09:00'), endMs: Date.parse('2026-09-17T10:00:00+09:00'), contact: false }] });
  c.writeHealineRange_(range, data(), null);
  assert.equal(posted.length, 0);
  const workoutEvent = saved.find(e => e.getTag('healineWorkout') === 'w1');
  const dayEvent = saved.find(e => e.getTag('healineDay') === '2026-09-17');
  assert.ok(workoutEvent.description.includes('다음 밤 회복 (2026-09-18 기상): HRV 30 ms (이전 8밤 중앙값 대비 -25%)'));
  assert.ok(workoutEvent.description.includes('종목 이름을 확인하지 못했습니다'));
  assert.ok(dayEvent.description.includes('28일 주평균 부하: 운동 조회 확인 20/28일'));
  assert.ok(dayEvent.description.includes('수면 중 피부 온도 중앙값 34.1°C · 이전 6밤 대비 +0.4°C'));
  assert.ok(dayEvent.description.includes('미착용 1시간 0분'));
  assert.ok(dayEvent.description.includes('추가 측정 읽기 권한 필요'));
  const day = calendarData(dayEvent.description);
  assert.equal(day.training.cardioLoad7, 85.5);
  assert.equal(day.skinTemperature.deviationCelsius, 0.4);
  assert.equal(day.wear.noContactMinutes, 60);

  withNote(workoutEvent, '언덕 반복\nRPE 8');
  withNote(dayEvent, '컨디션 2');
  c.writeHealineRange_(range, data(), null);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].kind, 'checkin');
  assert.deepEqual(posted[0].payload.checkins, [{ type: 'day_condition', value: 2 }, { type: 'workout_rpe', workoutId: 'w1', value: 8 }]);
  assert.ok(workoutEvent.description.includes('내 체감 RPE 8/10'));
  assert.equal(calendarData(workoutEvent.description).ownerRpe1To10, 8);
  assert.equal(calendarData(dayEvent.description).ownerCondition1To5, 2);
  assert.ok(workoutEvent.description.endsWith('언덕 반복\nRPE 8'));

  // A workout event that cannot be read keeps its earlier check-in instead of deleting it.
  const stored = data();
  stored.checkins = [{ type: 'workout_rpe', date: '2026-09-17', target: 'w1', value: 8 }];
  saved.splice(saved.indexOf(workoutEvent), 1);
  c.writeHealineRange_(range, stored, null);
  assert.deepEqual(posted[1].payload.checkins, [{ type: 'day_condition', value: 2 }, { type: 'workout_rpe', workoutId: 'w1', value: 8 }]);
});
