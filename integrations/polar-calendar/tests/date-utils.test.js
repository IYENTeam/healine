const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({
  Date,
  Math,
  Number,
  HEALINE: {
    windowMinutes: 15,
    timezone: 'Asia/Seoul',
    timezoneOffset: '+09:00'
  }
});

vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'DateUtils.gs'), 'utf8'),
  context
);

test('builds six complete 15-minute windows for a 90-minute backfill', () => {
  const windows = context.recentCompleteWindows_(
    new Date('2026-09-04T01:07:00.000Z'),
    90
  );

  assert.equal(windows.length, 6);
  assert.equal(windows[0].start.toISOString(), '2026-09-03T23:30:00.000Z');
  assert.equal(windows[0].end.toISOString(), '2026-09-03T23:45:00.000Z');
  assert.equal(windows[5].start.toISOString(), '2026-09-04T00:45:00.000Z');
  assert.equal(windows[5].end.toISOString(), '2026-09-04T01:00:00.000Z');
});
