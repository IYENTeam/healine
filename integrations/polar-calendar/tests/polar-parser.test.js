const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { context } = require('./helpers').load();

test('parses AccessLink v4 heart-rate samples and local offsets', () => {
  const samples = context.extractHeartRateSamples_({
    continuousSamples: {
      heartRateSamplesPerDay: [{
        date: '2026-09-03',
        samples: [
          { heartRate: 72, offsetMillis: 60_000, triggerType: 'TRIGGER_TIMED_247' },
          { heartRate: 75, offsetMillis: 360_000, triggerType: 'TRIGGER_HIGH_247' }
        ]
      }]
    }
  });

  assert.equal(samples.length, 2);
  assert.equal(samples[0].heartRate, 72);
  assert.equal(
    new Date(samples[0].timestampMs).toISOString(),
    '2026-09-02T15:01:00.000Z'
  );
});

test('parses one-minute activity vectors', () => {
  const result = context.extractActivityData_({
    activities: {
      activityDays: [{
        date: '2026-09-03',
        physicalInformation: { restingHeartRate: '57' },
        activitiesPerDevice: [{
          activitySamples: [{
            stepSamples: {
              startTime: '14:00:00',
              interval: '60000',
              steps: [0, 4, 8]
            },
            metSamples: {
              startTime: '14:00:00',
              interval: '60000',
              mets: [1.1, 1.8, 2.4]
            }
          }]
        }]
      }]
    }
  });

  assert.equal(result.restingHeartRate, 57);
  assert.deepEqual(
    Array.from(result.stepSamples, sample => sample.steps),
    [0, 4, 8]
  );
  assert.deepEqual(
    Array.from(result.metSamples, sample => sample.met),
    [1.1, 1.8, 2.4]
  );
  assert.equal(
    new Date(result.metSamples[2].timestampMs).toISOString(),
    '2026-09-03T05:02:00.000Z'
  );
});


test('null and sentinel activity data are missing, duplicate timestamps are not double-counted', () => {
  const result = context.extractActivityData_({activities:{activityDays:[{
    date:'2026-09-17',activitiesPerDevice:[{activitySamples:[
      {metSamples:{startTime:'14:00:00',interval:'60000',mets:[null,0,'',1.1]},stepSamples:{startTime:'14:00:00',interval:'60000',steps:[null,0,3,4]}},
      {stepSamples:{startTime:'14:02:00',interval:'60000',steps:[3,4]}}
    ]}]
  }]}});
  assert.equal(result.metSamples.length,1);
  assert.equal(result.stepSamples.reduce((n,s)=>n+s.steps,0),7);
});
test('multiple watches do not multiply a day of activity', () => {
  const device={activitySamples:[{stepSamples:{startTime:'14:00:00',interval:'60000',steps:[5,6]}}]};
  const result=context.extractActivityData_({activities:{activityDays:[{date:'2026-09-17',activitiesPerDevice:[device,device]}]}});
  assert.equal(result.stepSamples.reduce((n,s)=>n+s.steps,0),11);
});
test('featured activity requests are split into single days with exclusive ends', () => {
  const {context:c}=require('./helpers').load();const calls=[];
  c.polarGet_=(path,params)=>{calls.push({path,...params});return {};};
  c.fetchActivityRange_('2026-09-16','2026-09-18');
  assert.equal(calls.length,2);
  assert.equal(calls[0].from,'2026-09-16');assert.equal(calls[0].to,'2026-09-17');
  assert.equal(calls[1].from,'2026-09-17');assert.equal(calls[1].to,'2026-09-18');
});
test('sleep uses the documented nested hypnogram, offsets, and source score', () => {
  const sleeps=context.extractSleeps_({nightSleeps:[{sleepDate:'2026-09-17',sleepResult:{hypnogram:{sleepStart:'2026-09-16T23:30:00+09:00',sleepEnd:'2026-09-17T07:00:00+09:00'}},sleepScore:{sleepScore:81}}]});
  assert.equal(sleeps[0].durationMinutes,450);assert.equal(sleeps[0].score,81);
  assert.equal(sleeps[0].date,'2026-09-17');
});
test('403 for optional sleep is remembered without disabling core data collection', () => {
  const {context:c}=require('./helpers').load();let calls=0;
  c.polarGet_=()=>{calls++;return {healineForbidden:true};};
  assert.equal(c.fetchSleepRange_('2026-09-16','2026-09-18').access,'needs_connection');
  assert.equal(c.fetchSleepRange_('2026-09-16','2026-09-18').access,'needs_connection');
  assert.equal(calls,1);
});
test('temporary sleep errors retry on the next poll instead of becoming permanent denied access', () => {
  const {context:c}=require('./helpers').load();let calls=0;
  c.polarGet_=()=>{calls++;throw new Error('simulated server failure');};
  assert.equal(c.fetchSleepRange_('2026-09-17','2026-09-18').access,'error');
  c.fetchSleepRange_('2026-09-17','2026-09-18');assert.equal(calls,2);
});
test('multi-valued features use repeated query keys, not comma-joined strings', () => {
  assert.equal(context.encodeQuery_({features:['sleep-result','sleep-score']}),'features=sleep-result&features=sleep-score');
});
