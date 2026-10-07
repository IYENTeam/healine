const assert = require('node:assert/strict');
const test = require('node:test');
const { load } = require('./helpers');

function paired(extra = {}) {
  const result = load(extra);
  result.properties.setProperties({
    HEALINE_PLATFORM_URL: 'https://healine.example.com',
    HEALINE_PLATFORM_COLLECTOR_KEY: 'test-collector-key'
  });
  return result;
}

test('paired calendar reads persisted platform observations and fails closed on outage', () => {
  const { context: c } = paired();
  const window = { start: new Date('2026-09-17T00:00:00+09:00'), end: new Date('2026-09-17T12:00:00+09:00') };
  const calls = [];
  c.syncPlatformRange_ = (from, to) => calls.push([from, to]);
  c.polarGet_ = () => assert.fail('legacy read must not run after pairing');
  c.readPlatformObservations_ = () => ({ source: 'healine-platform', heartRateSamples: [] });
  assert.equal(c.fetchPolarWindowData_(window).source, 'healine-platform');
  assert.deepEqual(calls, [['2026-09-17', '2026-09-18']]);
  c.syncPlatformRange_ = () => { throw new Error('platform unavailable'); };
  assert.throws(() => c.fetchPolarWindowData_(window), /platform unavailable/);
});

test('provider failure is delivered with its status and does not skip other resource types', () => {
  const { context: c } = paired();
  const calls = [], batches = [];
  c.getValidPolarAccessToken_ = () => 'test-polar-token';
  c.fetchPolarWithToken_ = (url, token) => {
    assert.equal(token, 'test-polar-token');
    calls.push(url);
    const denied = url.includes('/activity/list');
    return { getResponseCode: () => denied ? 403 : 200, getContentText: () => JSON.stringify(denied ? { error: 'forbidden' } : {}) };
  };
  c.platformRequest_ = (path, payload) => { assert.equal(path, '/batches'); batches.push(payload); return { status: 'empty' }; };
  c.syncPlatformRange_('2026-09-17', '2026-09-18');
  assert.equal(batches.length, 5);
  assert.equal(batches[1].kind, 'activity');
  assert.equal(batches[1].http_status, 403);
  assert.equal(batches[1].payload.error, 'forbidden');
  assert.equal(batches[3].kind, 'recovery');
  assert.equal(batches[4].kind, 'workout');
  assert.ok(calls[2].includes('features=sleep-result&features=sleep-score'));
  assert.ok(!JSON.stringify(batches).includes('test-polar-token'));
});

test('collector credential stays in the header and redirects are disabled', () => {
  const { context: c } = paired({ UrlFetchApp: { fetch(url, options) {
    assert.equal(url, 'https://healine.example.com/api/v1/collectors/batches');
    assert.equal(options.headers['X-Healine-Collector-Key'], 'test-collector-key');
    assert.equal(options.followRedirects, false);
    assert.ok(!options.payload.includes('test-collector-key'));
    return { getResponseCode: () => 503, getContentText: () => 'private upstream error' };
  } } });
  assert.throws(() => c.platformRequest_('/batches', { kind: 'activity' }), /503/);
});

test('missing workout scope keeps existing collection active and does not invent an empty workout response', () => {
  const {context:c,properties}=paired();properties.setProperty('POLAR_GRANTED_SCOPES','sleep:read activity:read continuous_samples:read nightly_recharge:read');
  c.getValidPolarAccessToken_=()=> 'test';
  const batches=[];c.fetchPolarWithToken_=url=>{
    assert.ok(!url.includes('training-sessions'));return {getResponseCode:()=>200,getContentText:()=> '{}'};
  };
  c.platformRequest_=(_path,payload)=>{batches.push(payload);return {status:'empty'};};
  assert.equal(c.syncPlatformRange_('2026-09-17','2026-09-18').complete,true);
  assert.equal(batches.length,4);assert.equal(c.getWorkoutAccess_(),'needs_connection');
});

test('workout forbidden response is retained once then pauses workout requests without blocking other resources', () => {
  const {context:c}=paired();c.getValidPolarAccessToken_=()=> 'test';
  let workouts=0,other=0;
  c.fetchPolarWithToken_=url=>{const denied=url.includes('training-sessions');if(denied)workouts++;else other++;
    return {getResponseCode:()=>denied?403:200,getContentText:()=> '{}'};};
  c.platformRequest_=(_path,payload)=>({status:payload.http_status===403?'provider_error':'empty'});
  assert.equal(c.syncPlatformRange_('2026-09-17','2026-09-19').complete,true);
  assert.equal(workouts,1);assert.equal(other,8);assert.equal(c.getWorkoutAccess_(),'needs_connection');
});

test('workout detail requests use one-day exclusive ranges and preserve every requested feature', () => {
  const {context:c}=paired();c.getValidPolarAccessToken_=()=> 'test';const calls=[];
  c.fetchPolarWithToken_=url=>{calls.push(new URL(url));return {getResponseCode:()=>200,getContentText:()=>'{"trainingSessions":[]}'};};
  c.platformRequest_=()=>({status:'empty'});
  c.syncPlatformRange_('2026-09-17','2026-09-19',['workout']);
  assert.equal(calls.length,2);assert.equal(calls[0].searchParams.get('to'),'2026-09-18');
  assert.equal(calls[1].searchParams.get('from'),'2026-09-18');
  assert.ok(calls[0].searchParams.getAll('features').includes('samples'));
  assert.ok(calls[0].searchParams.getAll('features').includes('training-load-report'));
});

test('workout HTTP failures cannot mark a missing day as successfully collected', () => {
  const { context: c } = paired();
  c.getValidPolarAccessToken_ = () => 'test';
  c.fetchPolarWithToken_ = () => ({ getResponseCode: () => 404, getContentText: () => '{}' });
  c.platformRequest_ = () => ({ status: 'provider_error' });
  assert.equal(c.syncPlatformRange_('2026-09-17', '2026-09-18', ['workout']).complete, false);
  assert.equal(c.getWorkoutAccess_(), 'error');
});

test('pairing validates the nonce and HTTPS before sending the code', () => {
  const { context: c, properties } = load({ UrlFetchApp: { fetch() { assert.fail('must reject before HTTP'); } } });
  assert.throws(() => c.connectHealinePlatform_({ platform_nonce: 'wrong' }), /만료/);
  properties.setProperty('HEALINE_PLATFORM_SETUP_NONCE', 'nonce');
  assert.throws(() => c.connectHealinePlatform_({ platform_nonce: 'nonce', platform_url: 'http://localhost:8000' }), /HTTPS/);
  assert.equal(properties.getProperty('HEALINE_PLATFORM_SETUP_NONCE'), null);
});

test('successful pairing stores only the scoped key and starts the first sync', () => {
  const { context: c, properties } = load({
    HtmlService: { createHtmlOutput: html => html },
    UrlFetchApp: { fetch(url, options) {
      assert.equal(url, 'https://healine.example.com/api/v1/collectors/pair');
      assert.deepEqual(JSON.parse(options.payload), { code: 'one-time-code' });
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ key: 'new-key', connection_id: 'id' }) };
    } }
  });
  let runs = 0;
  c.runHealine = () => { runs++; };
  properties.setProperty('HEALINE_PLATFORM_SETUP_NONCE', 'nonce');
  const html = c.connectHealinePlatform_({ platform_nonce: 'nonce', platform_url: 'https://healine.example.com/', pairing_code: 'one-time-code' });
  assert.equal(properties.getProperty('HEALINE_PLATFORM_COLLECTOR_KEY'), 'new-key');
  assert.equal(properties.getProperty('HEALINE_PLATFORM_URL'), 'https://healine.example.com');
  assert.equal(runs, 1);
  assert.ok(!html.includes('new-key'));
  assert.ok(!html.includes('one-time-code'));
});
