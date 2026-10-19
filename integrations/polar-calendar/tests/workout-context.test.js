const assert=require('node:assert/strict');
const test=require('node:test');
const {load}=require('./helpers');

test('recorded strength exercise excludes low-movement HR from both current comparisons and future references',()=>{
  const {context:c}=load(), start=Date.parse('2026-09-17T14:00:00+09:00');
  const data={heartRateSamples:[1,6,11].map(m=>({timestampMs:start+m*60000,heartRate:115})),
    metSamples:Array.from({length:45},(_,i)=>({timestampMs:start+(i-30)*60000,met:1.2})),
    stepSamples:Array.from({length:15},(_,i)=>({timestampMs:start+i*60000,steps:0})),
    workouts:[{id:'strength',startMs:start-60000,endMs:start+1800000}]};
  const row=c.evaluateHealineRange_(data,start,start+900000,null)[0];
  assert.equal(row.status,'WORKOUT_RECORDED');assert.equal(row.comparisonEligible,false);
  assert.equal(Object.keys(c.buildBaseline_(data,'2026-09-17','2026-09-18').days).length,0);
  data.workouts=[{id:'strength',startMs:start-3600000,endMs:start-60000}];
  assert.equal(c.evaluateHealineRange_(data,start,start+900000,null)[0].status,'AFTER_WORKOUT');
});

test('workout backfill retains its checkpoint on failed persistence',()=>{
  const {context:c,properties}=load();c.LockService={getUserLock:()=>({tryLock:()=>true,releaseLock(){}})};
  c.isHealinePlatformConnected_=()=>true;c.getWorkoutAccess_=()=> 'granted';
  const today=c.formatIsoDate_(new Date());properties.setProperty('HEALINE_WORKOUT_BACKFILL_DATE',today);
  c.syncPlatformRange_=()=>({complete:true});c.readPlatformObservations_=()=>({workouts:[{id:'1'}]});
  c.getOrCreateHealineCalendar_=()=>({getEvents:()=>[]});c.upsertHealineWorkout_=()=>{throw Error('temporary service failure');};
  assert.throws(()=>c.backfillHealineWorkouts(),/temporary/);
  assert.equal(properties.getProperty('HEALINE_WORKOUT_BACKFILL_DATE'),today);
});
