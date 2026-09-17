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
test('cleanup deletes only fully recognized legacy events after replacement exists', () => {
  const {c}=setup(); const time=new Date('2026-09-17T14:00:00+09:00');
  function event(text, key='20260917-1400') {
    const e=new Event('old',time,new Date(time.getTime()+900000),text);e.tags.healineWindow=key;return e;
  }
  const text='Healine 실험용 생리 상태 추정\n상태: 안정\n\n[healine:20260917-1400]';
  const old=event(text), annotated=event(text+'\n내가 쓴 기록'), manual=event('사용자 일정'), unreplaced=event(text);
  assert.equal(c.cleanupLegacyHealineEvents_([unreplaced],{},96),0);
  assert.equal(c.cleanupLegacyHealineEvents_([old,annotated,manual],{'2026-09-17-14':true},96),1);
  assert.equal(old.deleted,true); assert.equal(annotated.deleted,false); assert.equal(manual.deleted,false);
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
  const a=c.runHealine();const count=saved.length;
  const b=c.runHealine();
  assert.equal(a.hourlyRecordCount,1);assert.equal(b.hourlyRecordCount,1);
  assert.equal(saved.length,count);assert.equal(manual.title,'회의');assert.equal(manual.deleted,false);
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
