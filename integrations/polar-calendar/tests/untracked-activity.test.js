const assert = require('node:assert/strict');
const test = require('node:test');
const { load } = require('./helpers');

const H = 3600000;
const day = Date.parse('2026-11-06T00:00:00+09:00');
function hour(h, hr, steps) { return { startMs: day + h * H, endMs: day + (h + 1) * H, medianHeartRate: hr, steps }; }

test('merges consecutive high-step raised-HR hours that no workout overlaps', () => {
  const { context: c } = load();
  const hours = [hour(8, 93, 2421), hour(12, 82, 2779), hour(19, 86, 846),
    hour(22, 91, 1964), hour(20, 100, 1951), hour(21, 103, 2798), hour(23, 82, 432)];
  const spans = c.untrackedActiveSpans_({ hours, workouts: [] });
  assert.equal(spans.length, 2);
  assert.equal(spans[1].startMs, day + 20 * H);
  assert.equal(spans[1].endMs, day + 23 * H);
  assert.equal(spans[1].steps, 6713);
  assert.equal(spans[1].minHeartRate, 91);
  assert.equal(spans[1].maxHeartRate, 103);
});

test('skips hours overlapping a workout and missing values', () => {
  const { context: c } = load();
  const hours = [hour(8, 93, 2421), hour(9, null, 3000), hour(10, 120, null)];
  const workouts = [{ startMs: day + 8.5 * H, endMs: day + 8.75 * H }];
  assert.equal(c.untrackedActiveSpans_({ hours, workouts }).length, 0);
});
