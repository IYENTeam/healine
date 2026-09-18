const assert = require('node:assert/strict');
const test = require('node:test');
const { load } = require('./helpers');
class Event {
  constructor(title, start, end, description) { Object.assign(this, {title,start,end,description,tags:{},color:'',mutations:0,deleted:false}); }
  getTag(k) { return this.tags[k] || ''; }
  setTag(k,v) { this.tags[k]=v;this.mutations++; }
  getTitle() { return this.title; }
  setTitle(v) { this.title=v;this.mutations++; }
  getDescription() { return this.description; }
  setDescription(v) { this.description=v;this.mutations++; }
  getStartTime() { return this.start; }
  getEndTime() { return this.end; }
  setTime(a,b) { this.start=a;this.end=b;this.mutations++; }
  getColor() { return this.color; }
  setColor(v) { this.color=v;this.mutations++; }
  removeAllReminders() { this.noReminders=true; }
  setTransparency(v) { this.transparency=v; }
  deleteEvent() { this.deleted=true; }
}
function setup() {
  const saved=[];
  const calendar = {
    getEvents(a,b) { return saved.filter(e => !e.deleted && e.start < b && e.end > a); },
    createEvent(t,a,b,o) { const e=new Event(t,a,b,o.description);saved.push(e);return e; },
    createAllDayEvent(t,a,o) { return this.createEvent(t,a,new Date(a.getTime()+86400000),o); }
  };
  const { context:c, properties } = load({CalendarApp:{EventColor:{GREEN:'10',GRAY:'8',BLUE:'9',ORANGE:'6',MAUVE:'3'},EventTransparency:{TRANSPARENT:'transparent'}}});
  return {c,calendar,saved,properties};
}
test('daily summaries are idempotent, free of reminders, and preserve personal notes', () => {
  const {c,calendar,saved}=setup(); const events=[];
  const day=c.buildDailySummary_('2026-09-17',[],{sleepAccess:'needs_connection'});
  c.upsertHealineDay_(calendar,events,day);
  const e=saved[0], count=e.mutations;
  c.upsertHealineDay_(calendar,events,day);
  assert.equal(saved.length,1); assert.equal(e.mutations,count);
  assert.equal(e.noReminders,true); assert.equal(e.transparency,'transparent');
  e.description=e.description.split('\n\n[내 메모]\n')[0]+'\n\n[내 메모]\n오후 회의 후 피곤했음';
  day.steps=123;
  c.upsertHealineDay_(calendar,events,day);
  assert.ok(e.description.endsWith('오후 회의 후 피곤했음'));
});
test('sleep crossing midnight updates its original tagged event', () => {
  const {c,calendar,saved}=setup();
  const sleep={date:'2026-09-17',startMs:Date.parse('2026-09-16T23:00:00+09:00'),endMs:Date.parse('2026-09-17T07:00:00+09:00'),durationMinutes:480};
  c.upsertHealineSleep_(calendar,[],sleep);
  c.upsertHealineSleep_(calendar,[],{...sleep,endMs:sleep.endMs+600000,durationMinutes:490});
  assert.equal(saved.length,1);assert.equal(saved[0].end.getTime(),sleep.endMs+600000);
});
test('full polling pass updates matching records without duplicating or touching manual events', () => {
  const {c,calendar,saved,properties}=setup();
  const now=new Date('2026-09-17T14:32:00+09:00');
  class FakeDate extends Date {constructor(...a){super(...(a.length?a:[now.getTime()]));}static now(){return now.getTime();}}
  c.Date=FakeDate;
  c.LockService={getUserLock:()=>({tryLock:()=>true,releaseLock(){}})};
  c.assertHealineConfigured_=()=>({}); c.getOrCreateHealineCalendar_=()=>calendar;
  c.getBaseline_=()=>({version:2,days:{}});
  const start=Date.parse('2026-09-17T14:00:00+09:00');
  c.fetchPolarWindowData_=()=>({
    heartRateSamples:[1,6,11,16,21,26].map(m=>({timestampMs:start+m*60000,heartRate:70})),
    metSamples:[],stepSamples:[],nightlyRecharges:[],sleeps:[],sleepAccess:'needs_connection'
  });
  const manual=calendar.createEvent('회의',new Date(start),new Date(start+3600000),{description:'직접 입력'});
  const legacyText='Healine 실험용 생리 상태 추정\n상태: 안정 내가 쓴 메모: 회의 후 피곤함\n\n[healine:20260917-1400]';
  const legacy=calendar.createEvent('old',new Date(start),new Date(start+900000),{description:legacyText});
  legacy.setTag('healineWindow','20260917-1400');
  const a=c.runHealine();const count=saved.length;
  const b=c.runHealine();
  assert.equal(a.hourlyRecordCount,1);assert.equal(b.hourlyRecordCount,1);
  assert.equal(saved.length,count);assert.equal(manual.title,'회의');assert.equal(manual.deleted,false);
  assert.equal(legacy.deleted,false);assert.equal(legacy.description,legacyText);
  assert.ok(properties.getProperty(c.HEALINE.propertyKeys.lastResult));
});

test('a missing canonical calendar does not create a replacement or write another calendar', () => {
  const {context:c}=load({CalendarApp:{getCalendarById:()=>null}});
  assert.throws(()=>c.getOrCreateHealineCalendar_(),/기존 Healine 캘린더/);
});

test('looking up many hourly keys does not repeatedly query every event tag', () => {
  const {c}=setup();let tagReads=0;
  const events=Array.from({length:200},(_,i)=>({getTag(){tagReads++;return 'hour-'+i;}}));
  for(let i=0;i<40;i++) assert.ok(c.findHealineEvent_(events,'healineHour','hour-'+i));
  assert.equal(tagReads,200);
});

function calendarData(description) {
  const text=description.split('[HEALINE_DATA_V1]\n')[1].split('\n[/HEALINE_DATA_V1]')[0];
  return JSON.parse(text);
}
function observedWindows(c, dense=false) {
  const start=Date.parse('2026-09-17T14:00:00+09:00');
  const heartRateSamples=Array.from({length:dense?3600:12},(_,i)=>({
    timestampMs:start+i*(dense?1000:300000),heartRate:60+i%41
  }));
  const metSamples=Array.from({length:90},(_,i)=>({timestampMs:start+(i-30)*60000,met:i%2?1.1:1.2}));
  const stepSamples=Array.from({length:60},(_,i)=>({timestampMs:start+i*60000,steps:0}));
  return Array.from({length:4},(_,i)=>c.evaluateHealineWindow_({
    windowStartMs:start+i*900000,windowEndMs:start+(i+1)*900000,heartRateSamples,metSamples,stepSamples
  }));
}

test('hour descriptions export bounded minute data, explicit UTC timestamps and units', () => {
  const {c,calendar,saved}=setup();
  const hour=c.buildHourlyObservations_(observedWindows(c,true))[0];hour.source='healine-platform';
  c.upsertHealineHour_(calendar,[],hour);
  const e=saved[0], data=calendarData(e.description);
  assert.equal(data.schema,'healine.calendar.v1');
  assert.equal(data.kind,'hour');assert.equal(data.timezone,'Asia/Seoul');
  assert.equal(data.start,'2026-09-17T05:00:00.000Z');
  assert.equal(data.minutes.length,60);assert.equal(data.quarters.length,4);
  assert.equal(data.minutes[0][data.minuteColumns.indexOf('hr_samples')],60);
  assert.equal(data.minutes[0][data.minuteColumns.indexOf('steps_sample_sum')],0);
  assert.equal(data.quarters[3].heartRate.lastAt,'2026-09-17T05:59:59.000Z');
  assert.equal(data.quarters[0].comparison,null);
  assert.ok(e.description.includes('평균 MET 1.15'));
  assert.ok(Buffer.byteLength(e.description,'utf8')<16000);
  e.description=e.description.split('\n\n[내 메모]\n')[0]+'\n\n[내 메모]\n이 시간에 회의';
  c.upsertHealineHour_(calendar,[e],hour);const count=e.mutations;
  c.upsertHealineHour_(calendar,[e],hour);
  assert.equal(saved.length,1);assert.equal(e.mutations,count);
  assert.ok(e.description.endsWith('이 시간에 회의'));
});

test('daily exports retain dated overnight values, observed ranges and missing-versus-zero context', () => {
  const {c}=setup();
  const day=c.buildDailySummary_('2026-09-17',observedWindows(c),{
    source:'healine-platform',sleepAccess:'granted',nightlyRecharges:[{
      sleepResultDate:'2026-09-17',recoveryIndicator:4,meanNightlyRecoveryRri:1000,
      meanBaselineRri:1200,meanNightlyRecoveryRmssd:40,meanBaselineRmssd:50
    }],
    sleeps:[{date:'2026-09-17',startMs:Date.parse('2026-09-16T23:00:00+09:00'),
      endMs:Date.parse('2026-09-17T07:00:00+09:00'),durationMinutes:480,score:75}],
    diagnostics:[{date:'2026-09-17',kind:'heart_rate',status:'processed',code:'ok',http_status:200,
      fetchedAt:'2026-09-17T07:00:00+00:00'}]
  });
  const description=c.dailyDescription_(day), data=calendarData(description);
  assert.equal(data.recovery.date,'2026-09-17');
  assert.equal(data.recovery.heartRateFromMeanRriBpm,60);
  assert.equal(data.recovery.baselineHeartRateFromMeanRriBpm,50);
  assert.equal(data.sleep.intervalMinutesIncludingAwake,480);
  assert.equal(data.sleep.start,'2026-09-16T14:00:00.000Z');
  assert.equal(data.activity.observedSteps,0);assert.equal(data.heartRate.samples,12);
  assert.equal(data.hours.length,1);
  assert.equal(data.hours[0][data.hourColumns.indexOf('hr_min_bpm')],60);
  assert.equal(data.hours[0][data.hourColumns.indexOf('hr_max_bpm')],71);
  assert.equal(data.hours[0][data.hourColumns.indexOf('compared_quarters')],0);
  assert.equal(data.collection[0].lastFetchedAt,'2026-09-17T07:00:00.000Z');
  assert.notEqual(data.collection[0].lastFetchedAt,data.heartRate.lastAt);
  assert.ok(description.includes('시간대별 흐름'));
  const missing=calendarData(c.dailyDescription_(c.buildDailySummary_('2026-09-18',[],{})));
  assert.equal(missing.activity.observedSteps,null);
  assert.equal(missing.activity.metAtLeast2ObservedMinutes,null);
  assert.equal(missing.recovery.rmssdMs,null);assert.equal(missing.sleep,null);
  assert.equal(missing.heartRate.lastAt,null);assert.equal(missing.hours.length,0);
});

test('polling publishes observed zero activity without heart rate and skips empty hours', () => {
  const {c,calendar,saved}=setup();const now=new Date('2026-09-17T14:32:00+09:00');
  class FakeDate extends Date {constructor(...a){super(...(a.length?a:[now.getTime()]));}static now(){return now.getTime();}}
  c.Date=FakeDate;c.LockService={getUserLock:()=>({tryLock:()=>true,releaseLock(){}})};
  c.assertHealineConfigured_=()=>({});c.getOrCreateHealineCalendar_=()=>calendar;
  c.getBaseline_=()=>({version:2,days:{}});
  c.fetchPolarWindowData_=()=>({heartRateSamples:[],metSamples:[],
    stepSamples:[{timestampMs:Date.parse('2026-09-17T14:00:00+09:00'),steps:0}],sleeps:[]});
  assert.equal(c.runHealine().hourlyRecordCount,1);
  const hourly=saved.filter(e=>e.tags.healineHour);
  assert.equal(hourly.length,1);assert.equal(hourly[0].title,'🚶 활동 기록 · 0보');
  const data=calendarData(hourly[0].description);
  assert.equal(data.quarters[0].heartRate.medianBpm,null);
  assert.equal(data.quarters[0].activity.observedSteps,0);
  assert.equal(data.quarters[1].activity.observedSteps,null);
  assert.equal(data.quarters[0].activity.metAtLeast2ObservedMinutes,null);
  assert.equal(data.quarters[0].heartRateObservationStatus,'NO_DATA');
  assert.equal(data.quarters[0].activity.recentActivityObserved,null);
});

test('an empty snapshot clears stale hourly data consistently with the day and preserves notes', () => {
  const {c,calendar,saved}=setup();const now=new Date('2026-09-17T14:32:00+09:00');
  class FakeDate extends Date {constructor(...a){super(...(a.length?a:[now.getTime()]));}static now(){return now.getTime();}}
  c.Date=FakeDate;c.LockService={getUserLock:()=>({tryLock:()=>true,releaseLock(){}})};
  c.assertHealineConfigured_=()=>({});c.getOrCreateHealineCalendar_=()=>calendar;
  c.getBaseline_=()=>({version:2,days:{}});
  let heartRateSamples=[{timestampMs:Date.parse('2026-09-17T14:01:00+09:00'),heartRate:70}];
  c.fetchPolarWindowData_=()=>({heartRateSamples,metSamples:[],stepSamples:[],sleeps:[]});
  c.runHealine();const count=saved.length;
  const hour=saved.find(e=>e.tags.healineHour);
  hour.description=hour.description.split('\n\n[내 메모]\n')[0]+'\n\n[내 메모]\n잠깐 휴식';
  heartRateSamples=[];
  c.runHealine();
  assert.equal(saved.length,count);assert.equal(hour.title,'⌛ 관측 미수신');
  assert.equal(hour.deleted,false);assert.ok(hour.description.endsWith('잠깐 휴식'));
  const payload=calendarData(hour.description);
  assert.equal(payload.dataState,'no_observations_in_latest_snapshot');
  assert.equal(payload.minutes.length,0);assert.equal(payload.quarters[0].heartRate.samples,0);
  const daily=calendarData(saved.find(e=>e.tags.healineDay==='2026-09-17').description);
  assert.equal(daily.heartRate.samples,0);assert.equal(daily.hours.length,0);
  const previousDescription=hour.description;
  c.fetchPolarWindowData_=()=>{throw new Error('temporary fetch error');};
  assert.throws(()=>c.runHealine(),/temporary fetch error/);
  assert.equal(hour.description,previousDescription);
});
