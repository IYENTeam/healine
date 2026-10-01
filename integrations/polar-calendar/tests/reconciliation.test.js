const assert = require('node:assert/strict');
const test = require('node:test');
const { load } = require('./helpers');

function environment() {
  const result = load();
  const c = result.context;
  c.LockService={getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})};
  result.properties.setProperties({HEALINE_PLATFORM_URL:'https://healine.example.com',HEALINE_PLATFORM_COLLECTOR_KEY:'test-key'});
  c.readPlatformObservations_ = () => ({heartRateSamples:[],metSamples:[],stepSamples:[],sleeps:[]});
  c.writeHealineRange_ = () => ({hourlyRecordCount:3});
  c.syncPlatformRange_ = () => ({complete:true});
  return result;
}

test('historical calendar writes happen before a queued date is acknowledged', () => {
  const {context:c} = environment();
  const yesterday=c.addIsoDays_(c.formatIsoDate_(new Date()),-1);
  const from=c.addIsoDays_(yesterday,-2);
  c.queueHealineBackfill(from,yesterday);
  let writes=0;
  c.writeHealineRange_=range=>{writes++;assert.equal(c.formatIsoDate_(range.start),from);assert.equal(c.getHealineBackfill_().dates.length,2);return {hourlyRecordCount:24};};
  const result=c.reconcileHistoricalDay_();
  assert.equal(writes,1);assert.equal(result.remainingDates,1);assert.equal(result.hourlyRecordCount,24);
});

test('partial provider failures remain pending and do not starve other dates', () => {
  const {context:c} = environment();
  const end=c.addIsoDays_(c.formatIsoDate_(new Date()),-1), start=c.addIsoDays_(end,-2);
  c.queueHealineBackfill(start,end);
  c.syncPlatformRange_=()=>({complete:false});
  assert.equal(c.reconcileHistoricalDay_().pending,true);
  assert.equal(c.getHealineBackfill_().dates.length,2);
  c.syncPlatformRange_=()=>({complete:true});
  assert.equal(c.reconcileHistoricalDay_().date,c.addIsoDays_(start,1));
  assert.equal(c.getHealineBackfill_().dates[0],start);
});

test('calendar failure retains its checkpoint and cached replay needs no Polar token', () => {
  const {context:c} = environment();
  const end=c.addIsoDays_(c.formatIsoDate_(new Date()),-1), start=c.addIsoDays_(end,-1);
  c.queueHealineBackfill(start,end);
  c.writeHealineRange_=()=>{throw Error('simulated calendar outage');};
  assert.equal(c.reconcileHistoricalDay_().pending,true);
  assert.equal(c.getHealineBackfill_().failures[start].phase,'write_calendar');
  assert.match(c.getHealineBackfill_().lastFailure.message,/simulated calendar outage/);
  c.syncPlatformRange_=()=>assert.fail('cached replay must not call Polar');
  c.writeHealineRange_=()=>({hourlyRecordCount:12});
  assert.equal(c.reconcileHistoricalDay_(true),null);
  const retry=c.getHealineBackfill_();retry.failures[start].retryAt=0;
  c.PropertiesService.getUserProperties().setProperty(c.HEALINE.propertyKeys.calendarBackfill,JSON.stringify(retry));
  assert.equal(c.reconcileHistoricalDay_(true).hourlyRecordCount,12);
  assert.equal(c.getHealineBackfill_().dates.length,0);
});

test('calendar creation limits pause all backfill dates, including cached replay', () => {
  const {context:c}=environment();
  c.LockService={getUserLock:()=>({tryLock:()=>true,releaseLock:()=>{}})};
  const end=c.formatIsoDate_(new Date()), start=c.addIsoDays_(end,-2);
  c.queueHealineBackfill(start,end);
  let writes=0;
  c.writeHealineRange_=()=>{writes++;throw Error('You have been creating or deleting too many calendars or calendar events in a short time. Please try again later.');};
  const result=c.continueHealineBackfill_(true);
  assert.equal(result.length,1);
  assert.equal(result[0].calendarLimited,true);
  assert.ok(c.getHealineBackfill_().calendarRetryAt>Date.now());
  assert.equal(c.reconcileHistoricalDay_(true),null);
  assert.equal(c.reconcileHistoricalDay_(false),null);
  assert.equal(writes,1);
  assert.equal(c.getHealineBackfill_().dates.length,2);
});

test('recent polling respects calendar cooldown while continuing source collection', () => {
  const {context:c}=environment();
  c.LockService={getUserLock:()=>({tryLock:()=>true,releaseLock:()=>{}})};
  c.assertHealineConfigured_=()=>{};
  c.getBaseline_=()=>({version:3,to:'9999-12-31',days:{}});
  let fetches=0,writes=0;
  c.fetchPolarWindowData_=()=>{fetches++;return {source:'healine-platform'};};
  c.writeHealineRange_=()=>{writes++;throw Error('You have been creating or deleting too many calendars or calendar events in a short time.');};
  assert.throws(()=>c.runHealine(),/too many calendars/);
  const result=c.runHealine();
  assert.ok(result.calendarDeferredUntil);
  assert.equal(fetches,2);
  assert.equal(writes,1);
});

test('Korean Calendar creation limits pause both cached and live backfill', () => {
  const {context:c}=environment();
  c.LockService={getUserLock:()=>({tryLock:()=>true,releaseLock(){}})};
  const end=c.formatIsoDate_(new Date());
  c.queueHealineBackfill(c.addIsoDays_(end,-2),end);
  let writes=0;
  c.writeHealineRange_=()=>{writes++;throw Error('짧은 시간에 캘린더 또는 캘린더 이벤트를 너무 많이 만들거나 삭제했습니다. 잠시 후 다시 시도해 주세요.');};
  const result=c.continueHealineBackfill_(true);
  assert.equal(result.length,1);assert.equal(result[0].calendarLimited,true);
  assert.equal(c.reconcileHistoricalDay_(false),null);
  assert.equal(c.reconcileHistoricalDay_(true),null);
  assert.equal(writes,1);
  assert.equal(c.isCalendarRateLimit_('Healine 플랫폼 요청 실패 (500)'),false);
});

test('cached replay does not retry the same failing date within one invocation', () => {
  const {context:c}=environment();
  c.LockService={getUserLock:()=>({tryLock:()=>true,releaseLock:()=>{}})};
  const end=c.formatIsoDate_(new Date()), start=c.addIsoDays_(end,-2);
  c.queueHealineBackfill(start,end);
  c.writeHealineRange_=()=>{throw Error('temporary failure');};
  const result=c.continueHealineBackfill_(true);
  assert.equal(result.length,2);
  assert.equal(new Set(result.map(r=>r.date)).size,2);
  assert.equal(c.getHealineBackfill_().failures[start].attempts,1);
});

test('a full failed backfill queue stays within the Apps Script property limit', () => {
  const {context:c}=environment();
  c.console={log(){},warn(){}};
  c.buildBaseline_=()=>null;
  const end=c.formatIsoDate_(new Date()), start=c.addIsoDays_(end,-60);
  c.queueHealineBackfill(start,end);
  c.writeHealineRange_=()=>{throw Error('임시 서비스 오류'.repeat(100));};
  const attempted=[];
  for(let i=0;i<60;i++) attempted.push(c.reconcileHistoricalDay_(true,attempted).date);
  assert.equal(Object.keys(c.getHealineBackfill_().failures).length,60);
  assert.ok(Buffer.byteLength(JSON.stringify(c.getHealineBackfill_()),'utf8')<8500);
});

test('backfill enforces a bounded exclusive range and deduplicates jobs', () => {
  const {context:c}=environment();
  const end=c.formatIsoDate_(new Date()), from=c.addIsoDays_(end,-5);
  c.queueHealineBackfill(from,end);c.queueHealineBackfill(from,end);
  assert.equal(c.getHealineBackfill_().dates.length,5);
  assert.throws(()=>c.queueHealineBackfill(c.addIsoDays_(end,-61),end));
  assert.throws(()=>c.queueHealineBackfill(end,from));
});

test('origin repair rolls back a failed connection and never rotates credentials', () => {
  const {context:c,properties}=environment();
  c.readPlatformObservations_=()=>{throw Error('unreachable');};
  assert.throws(()=>c.repairHealinePlatformConnection(),/unreachable/);
  assert.equal(properties.getProperty('HEALINE_PLATFORM_URL'),'https://healine.example.com');
  assert.equal(properties.getProperty('HEALINE_PLATFORM_COLLECTOR_KEY'),'test-key');
});

test('invalid grant is actionable and token storage clears a reconnect block', () => {
  const {context:c,properties}=environment();
  c.recordHealineFailure_(Error('invalid_grant'));
  assert.throws(()=>c.refreshPolarToken_(),/POLAR_RECONNECT_REQUIRED/);
  c.savePolarToken_({access_token:'test',refresh_token:'test-refresh',expires_in:3600});
  assert.equal(properties.getProperty('HEALINE_LAST_ERROR'),null);
  assert.equal(properties.getProperty('HEALINE_CALENDAR_CATCHUP_PENDING'),'1');
  c.applyPendingHealineCatchup_();
  assert.equal(c.getHealineBackfill_().dates.length,30);
  const queued=JSON.stringify(c.getHealineBackfill_());
  c.savePolarToken_({access_token:'refreshed',expires_in:3600});
  assert.equal(JSON.stringify(c.getHealineBackfill_()),queued);
});

test('reauthorization during cached replay preserves a fresh source catch-up request', () => {
  const {context:c,properties}=environment();
  const end=c.formatIsoDate_(new Date()), start=c.addIsoDays_(end,-1);
  c.queueHealineBackfill(start,end);
  c.recordHealineFailure_(Error('invalid_grant'));
  c.writeHealineRange_=()=>{
    c.savePolarToken_({access_token:'test',refresh_token:'test-refresh'});
    return {hourlyRecordCount:24};
  };
  c.reconcileHistoricalDay_(true);
  assert.equal(c.getHealineBackfill_().dates.length,0);
  assert.equal(properties.getProperty('HEALINE_CALENDAR_CATCHUP_PENDING'),'1');
  c.applyPendingHealineCatchup_();
  assert.equal(c.getHealineBackfill_().dates.length,30);
  assert.equal(properties.getProperty('HEALINE_CALENDAR_CATCHUP_PENDING'),null);
});

test('known authorization failure keeps fresh-source jobs pending without creating historical warning-only events', () => {
  const {context:c}=environment();
  const end=c.formatIsoDate_(new Date()), start=c.addIsoDays_(end,-1);
  c.queueHealineBackfill(start,end);c.recordHealineFailure_(Error('invalid_grant'));
  c.syncPlatformRange_=()=>assert.fail('known invalid authorization must not be retried');
  c.writeHealineRange_=()=>assert.fail('no historical warning-only write');
  assert.equal(c.reconcileHistoricalDay_(),null);
  assert.equal(c.getHealineBackfill_().dates.length,1);
});

test('cached replay of yesterday preserves the current authorization warning', () => {
  const {context:c}=environment();
  const end=c.formatIsoDate_(new Date()), start=c.addIsoDays_(end,-1);
  c.queueHealineBackfill(start,end);c.recordHealineFailure_(Error('invalid_grant'));
  let warning;
  c.writeHealineRange_=(_range,data)=>{warning=data.syncWarning;return {hourlyRecordCount:0};};
  c.reconcileHistoricalDay_(true);
  assert.match(warning,/Polar 인증/);
});

test('calendar readback detects duplicate and invalid records without counting notes or untagged text', () => {
  const {context:c}=environment();
  const data={schema:'healine.calendar.v1',modelVersion:3,kind:'hour',minutes:[[1],[2]],quarters:[{comparison:{priorDays:5}},{comparison:null}]};
  const description=c.calendarDataBlock_(data)+'\n[healine-hour:2026-09-21-09]';
  const event=(text,tag)=>({getDescription:()=>text,getTag:key=>key==='healine'+(text.includes('[healine-day:')?'Day':text.includes('[healine-sleep:')?'Sleep':'Hour')?tag:null});
  const result=c.auditHealineEvents_([
    event(description,'2026-09-21-09'),event(description,'2026-09-21-09'),
    event(description,null),event('\n\n[내 메모]\n'+description,null),
    event('[HEALINE_DATA_V1]\n{"schema":"healine.calendar.v1"','2026-09-21-10'),
    event('[healine-day:2026-09-21]','2026-09-21'),
    event('[healine-sleep:2026-09-21]','2026-09-21')
  ],'2026-09-21','2026-09-22');
  assert.equal(result.totals.hours,3);
  assert.equal(result.totals.days,1);
  assert.equal(result.totals.sleeps,1);
  assert.equal(result.totals.duplicates,1);
  assert.equal(result.totals.invalidData,2);
  assert.ok(result.dates[0].invalidKeys.includes('hour:2026-09-21-10'));
  assert.equal(result.totals.currentModel,2);
  assert.equal(result.totals.minuteRows,4);
  assert.equal(result.totals.comparedQuarters,2);
});
