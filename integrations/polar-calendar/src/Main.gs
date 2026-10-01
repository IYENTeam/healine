function setup() {
  assertHealineConfigured_();
  getValidPolarAccessToken_();
  getOrCreateHealineCalendar_();
  try { rebuildBaseline(); }
  catch (error) { console.warn('개인 기준 누적 중: ' + error.message); }
  installHealineTriggers_();
  return runHealine();
}

function runHealine() {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(10000)) return null;
  try {
    assertHealineConfigured_();
    applyPendingHealineCatchup_();
    var now = new Date();
    var today = formatIsoDate_(now);
    var range = {
      start: new Date(localDayStartMs_(addIsoDays_(today, -1))),
      end: previousCompleteWindow_(now).end
    };
    var properties = PropertiesService.getUserProperties();
    var data;
    try {
      data = fetchPolarWindowData_(range);
      properties.deleteProperty(HEALINE.propertyKeys.lastError);
    } catch (error) {
      var failure = recordHealineFailure_(error);
      if (!isHealinePlatformConnected_()) throw error;
      // Read retained platform data even when Polar needs reconnection. Never
      // invent measurements or switch to the unpaired collector path.
      data = readPlatformObservations_(formatIsoDate_(range.start), addIsoDays_(today, 1));
      data.syncWarning = failure.message;
    }
    var calendarRetryAt = getHealineBackfill_().calendarRetryAt || 0;
    if (calendarRetryAt > Date.now()) {
      // Calendar throttling must not delay recovery of older provider data.
      try { reconcileHistoricalDay_(); }
      catch (sourceError) { console.warn('과거 원본 수집 보류: ' + sourceError.message); }
      var deferred = { calendarDeferredUntil: new Date(calendarRetryAt).toISOString(), syncWarning: data.syncWarning || null };
      console.log(JSON.stringify(deferred));
      return deferred;
    }
    var baseline = getBaseline_();
    if ((!baseline || baseline.version !== HEALINE.modelVersion || baseline.to < today ||
        properties.getProperty(HEALINE.propertyKeys.baselineDirty) === '1') &&
        properties.getProperty(HEALINE.propertyKeys.baselineAttemptDate) !== today) {
      try { baseline = rebuildBaselineUnlocked_(); }
      catch (error) { console.warn('개인 기준 누적 중: ' + error.message); }
    }
    var result;
    try { result = writeHealineRange_(range, data, baseline); }
    catch (calendarError) {
      if (isCalendarRateLimit_(calendarError.message)) {
        var queue = getHealineBackfill_();
        queue.calendarRetryAt = Date.now() + 900000;
        queue.lastFailure = { date: today, phase: 'write_calendar',
          message: String(calendarError.message).slice(0, 300), at: new Date().toISOString() };
        properties.setProperty(HEALINE.propertyKeys.calendarBackfill, JSON.stringify(queue));
      }
      throw calendarError;
    }
    var windows = result.windows, dates = result.dates, summaries = result.summaries;
    var stored = {
      version: HEALINE.modelVersion, completedAt: now.toISOString(),
      processedWindowCount: windows.length, hourlyRecordCount: result.hourlyRecordCount,
      summaryDates: dates, latestHeartRateAt: summaries[summaries.length - 1].lastHeartRateAt,
      sleepAccess: data.sleepAccess, legacyEventsRemoved: 0,
      source: data.source || 'apps-script', syncWarning: data.syncWarning || null,
      baselineDays: baseline && baseline.version === HEALINE.modelVersion ? Object.keys(baseline.days).length : 0
    };
    properties.setProperty(HEALINE.propertyKeys.lastResult, JSON.stringify(stored));
    console.log(JSON.stringify(stored));
    try { reconcileHistoricalDay_(); }
    catch (backfillError) { console.warn('과거 기록 보강 보류: ' + backfillError.message); }
    return stored;
  } finally { lock.releaseLock(); }
}

function installHealineTriggers_() {
  removeHealineTriggers_();
  ScriptApp.newTrigger('runHealine').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('rebuildBaseline').timeBased().atHour(3).everyDays(1).create();
}

function removeHealineTriggers() {
  removeHealineTriggers_();
  console.log('자동 실행을 중단했습니다. 기존 기록은 유지됩니다.');
}

function removeHealineTriggers_() {
  var handlers = { runHealine: true, rebuildBaseline: true };
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (handlers[trigger.getHandlerFunction()]) ScriptApp.deleteTrigger(trigger);
  });
}

function getHealineStatus() {
  var config = getHealineConfig_();
  var properties = PropertiesService.getUserProperties();
  var baseline = getBaseline_();
  var lastError = JSON.parse(properties.getProperty(HEALINE.propertyKeys.lastError) || 'null');
  var hasToken = Boolean(properties.getProperty(HEALINE.propertyKeys.refreshToken));
  var reconnectRequired = isPolarReconnectRequired_();
  var status = {
    configured: Boolean(config.clientId && config.clientSecret && config.redirectUri),
    polarAuthorized: hasToken && !reconnectRequired,
    polarAuthorizationState: reconnectRequired ? 'reconnect_required' : hasToken ? 'token_present_not_verified' : 'not_connected',
    tokenLifecycle: getPolarTokenLifecycle_(),
    calendarName: config.calendarName,
    platformConnected: isHealinePlatformConnected_(),
    baselineVersion: baseline && baseline.version,
    baselineDays: baseline && baseline.days ? Object.keys(baseline.days).length : 0,
    sleepAccess: properties.getProperty(HEALINE.propertyKeys.sleepAccess),
    lastError: lastError,
    backfill: getHealineBackfill_(),
    reconnectCatchupPending: properties.getProperty(HEALINE.propertyKeys.calendarCatchupPending) === '1',
    lastBackfill: JSON.parse(properties.getProperty(HEALINE.propertyKeys.lastBackfill) || 'null'),
    triggers: ScriptApp.getProjectTriggers().map(function (trigger) { return trigger.getHandlerFunction(); }),
    lastResult: JSON.parse(properties.getProperty(HEALINE.propertyKeys.lastResult) || 'null')
  };
  console.log(JSON.stringify(status, null, 2));
  return status;
}

// Read back persisted calendar records; no token values or personal notes enter logs.
function getHealineCalendarAudit() {
  var today = formatIsoDate_(new Date()), from = addIsoDays_(today, -30), to = addIsoDays_(today, 1);
  var events = getOrCreateHealineCalendar_().getEvents(new Date(localDayStartMs_(from)), new Date(localDayStartMs_(to)));
  var result = auditHealineEvents_(events, from, to);
  result.dates.forEach(function (row) { console.log(JSON.stringify(row)); });
  console.log(JSON.stringify({ auditFrom: from, auditToExclusive: to, totals: result.totals }));
  return result;
}

function auditHealineEvents_(events, from, to) {
  var rows = {}, keys = {}, totals = { hours: 0, days: 0, sleeps: 0, currentModel: 0,
    duplicates: 0, invalidData: 0, minuteRows: 0, comparedQuarters: 0 };
  isoDatesBetween_(from, to).forEach(function (date) {
    rows[date] = { date: date, hours: 0, days: 0, sleeps: 0, currentModel: 0,
      duplicates: 0, invalidData: 0, minuteRows: 0, comparedQuarters: 0,
      invalidKeys: [], maxDescriptionLength: 0 };
  });
  events.forEach(function (event) {
    var kind = 'hour', key = event.getTag('healineHour');
    if (!key) { kind = 'day'; key = event.getTag('healineDay'); }
    if (!key) { kind = 'sleep'; key = event.getTag('healineSleep'); }
    if (!key) return;
    var date = key.slice(0, 10), row = rows[date];
    if (!row) return;
    var description = event.getDescription();
    row.maxDescriptionLength = Math.max(row.maxDescriptionLength, description.length);
    // Notes follow the generated marker; they must not be parsed as generated data.
    description = description.split('\n\n[내 메모]\n')[0];
    var counter = {hour: 'hours', day: 'days', sleep: 'sleeps'}[kind];
    row[counter] += 1;
    if (keys[kind + ':' + key]) row.duplicates += 1;
    keys[kind + ':' + key] = true;
    if (kind === 'sleep') return;
    var block = description.match(/\[HEALINE_DATA_V1\]\n([^\n]+)\n\[\/HEALINE_DATA_V1\]/);
    try {
      var data = block && JSON.parse(block[1]);
      if (!data || data.schema !== 'healine.calendar.v1' || data.kind !== kind) throw new Error('invalid_data');
      if (data.modelVersion === HEALINE.modelVersion) row.currentModel += 1;
      if (kind === 'hour') {
        row.minuteRows += (data.minutes || []).length;
        row.comparedQuarters += (data.quarters || []).filter(function (q) { return Boolean(q.comparison); }).length;
      }
    } catch (error) { row.invalidData += 1; row.invalidKeys.push(kind + ':' + key); }
  });
  var dates = Object.keys(rows).sort().map(function (date) { return rows[date]; });
  dates.forEach(function (row) {
    Object.keys(totals).forEach(function (key) { totals[key] += row[key]; });
  });
  return { dates: dates, totals: totals };
}

// The same writer handles recent data, old dates and replayed snapshots.
function writeHealineRange_(range, data, baseline) {
  data.nightlyHistory = baseline && baseline.nights || data.nightlyRecharges || [];
  var windows = evaluateHealineRange_(data, range.start.getTime(), range.end.getTime(), baseline);
  var calendar = getOrCreateHealineCalendar_();
  var events = calendar.getEvents(range.start, range.end);
  var hours = buildHourlyObservations_(windows), count = 0;
  hours.forEach(function (hour) {
    if (!hasHourlyObservations_(hour) && !findHealineEvent_(events, 'healineHour', hourKey_(hour.startMs))) return;
    hour.source = data.source || 'apps-script';
    upsertHealineHour_(calendar, events, hour); count += 1;
  });
  var dates = isoDatesBetween_(formatIsoDate_(range.start),
    addIsoDays_(formatIsoDate_(new Date(range.end.getTime() - 1)), 1));
  var summaries = dates.map(function (date) {
    var summary = buildDailySummary_(date, windows, data);
    if (summary.nightly || summary.sleep || summary.activityMinutes || summary.observedWindows ||
        summary.diagnostics.length || summary.syncWarning || findHealineEvent_(events, 'healineDay', date)) {
      upsertHealineDay_(calendar, events, summary);
    }
    if (summary.sleep) upsertHealineSleep_(calendar, events, summary.sleep);
    return summary;
  });
  return { windows: windows, dates: dates, summaries: summaries, hourlyRecordCount: count };
}

function evaluateHealineRange_(data, startMs, endMs, baseline) {
  var buckets = {};
  ['heartRateSamples', 'metSamples', 'stepSamples'].forEach(function (kind) {
    (data[kind] || []).forEach(function (sample) {
      var key = Math.floor(sample.timestampMs / 900000) * 900000;
      if (!buckets[key]) buckets[key] = { heartRateSamples: [], metSamples: [], stepSamples: [] };
      buckets[key][kind].push(sample);
    });
  });
  var output = [];
  for (var start = startMs; start < endMs; start += 900000) {
    var row = buckets[start] || {};
    var mets = [-1800000, -900000, 0].reduce(function (all, offset) {
      return all.concat((buckets[start + offset] || {}).metSamples || []);
    }, []);
    output.push(evaluateHealineWindow_({ windowStartMs: start, windowEndMs: start + 900000,
      heartRateSamples: row.heartRateSamples || [], metSamples: mets, stepSamples: row.stepSamples || [],
      sleeps: data.sleeps, baseline: baseline }));
  }
  return output;
}

function recordHealineFailure_(error) {
  if (error.polarGeneration !== undefined && error.polarGeneration !== (getPolarTokenLifecycle_().generation || 0)) {
    return { at: new Date().toISOString(), code: 'sync_superseded',
      message: 'Polar 연결이 갱신되었습니다. 다음 실행에서 다시 수집합니다.' };
  }
  var auth = /invalid_grant|POLAR_RECONNECT_REQUIRED|Polar 인증이 없습니다/.test(String(error.message));
  var failure = { at: new Date().toISOString(), code: auth ? 'polar_reconnect_required' : 'sync_failed',
    message: auth ? 'Polar 인증을 갱신할 수 없습니다. Healine 설정에서 Polar를 다시 연결하세요.' :
      '수집 연결을 확인해야 합니다. 아래는 마지막으로 저장된 기록입니다.' };
  PropertiesService.getUserProperties().setProperty(HEALINE.propertyKeys.lastError, JSON.stringify(failure));
  return failure;
}

function queueHealineBackfill(from, to) {
  var today = formatIsoDate_(new Date());
  from = from || addIsoDays_(today, -30); to = to || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
      from >= to || to > addIsoDays_(today, 1) || localDayStartMs_(to) - localDayStartMs_(from) > 60 * 86400000) {
    throw new Error('과거 1~60일의 날짜 범위를 지정하세요. 종료 날짜는 제외됩니다.');
  }
  var props = PropertiesService.getUserProperties();
  var state = getHealineBackfill_();
  state.dates = Array.from(new Set(state.dates.concat(isoDatesBetween_(from, to)))).sort();
  if (state.dates.length > 60) throw new Error('한 번에 최대 60일을 보충할 수 있습니다.');
  props.setProperty(HEALINE.propertyKeys.calendarBackfill, JSON.stringify(state));
  return { pendingDates: state.dates.length };
}

function getHealineBackfill_() {
  var raw = PropertiesService.getUserProperties().getProperty(HEALINE.propertyKeys.calendarBackfill);
  var state = raw ? JSON.parse(raw) : { dates: [], failures: {} };
  // Also recognize limits recorded before the shared cooldown was introduced.
  if (!state.calendarRetryAt && state.lastFailure && isCalendarRateLimit_(state.lastFailure.message)) {
    state.calendarRetryAt = (state.failures[state.lastFailure.date] || {}).retryAt || 0;
  }
  return state;
}

function isCalendarRateLimit_(message) {
  return /too many calendars or calendar events|too many times.*calendar|rate.?limit.?exceeded|quota.*calendar|짧은 시간에 캘린더|캘린더.*너무 많이|Calendar.*호출.*너무 많/i.test(String(message));
}

// Called only from a live run holding the user lock, never from cached replay.
function applyPendingHealineCatchup_() {
  var props = PropertiesService.getUserProperties();
  if (props.getProperty(HEALINE.propertyKeys.calendarCatchupPending) !== '1') return;
  try {
    queueHealineBackfill();
    var state = getHealineBackfill_();
    state.failures = {};
    state.sourceDates = [];
    props.setProperty(HEALINE.propertyKeys.calendarBackfill, JSON.stringify(state));
    props.deleteProperty(HEALINE.propertyKeys.calendarCatchupPending);
  } catch (error) { console.warn('재연결 후 과거 보충 예약 확인 필요: ' + error.message); }
}

function reconcileHistoricalDay_(cachedOnly, attemptedDates) {
  if (!isHealinePlatformConnected_()) return null;
  var props = PropertiesService.getUserProperties(), state = getHealineBackfill_();
  var calendarPaused = (state.calendarRetryAt || 0) > Date.now();
  if (calendarPaused && cachedOnly) return null;
  var sourceError = JSON.parse(props.getProperty(HEALINE.propertyKeys.lastError) || 'null');
  if (!cachedOnly && isPolarReconnectRequired_()) return null;
  var today = formatIsoDate_(new Date()), first = addIsoDays_(today, -30), yesterday = addIsoDays_(today, -1);
  var date = state.dates.filter(function (d) {
    var failure = state.failures[d];
    var sourceFailure = failure && (failure.phase === 'fetch_source' || failure.phase === 'source_completion');
    return (!attemptedDates || attemptedDates.indexOf(d) < 0) &&
      (!calendarPaused || (state.sourceDates || []).indexOf(d) < 0) &&
      (!failure || failure.retryAt <= Date.now() || (cachedOnly && sourceFailure) || (calendarPaused && !sourceFailure));
  })[0];
  var queued = Boolean(date);
  if (!date) {
    if (calendarPaused) return null;
    if (state.dates.length) return null;
    date = props.getProperty(HEALINE.propertyKeys.calendarSweepDate);
    if (!date || date < first || date >= yesterday) date = first;
  }
  var to = addIsoDays_(date, 1), complete = true, phase = 'fetch_source';
  var warning = cachedOnly && sourceError && date >= yesterday ? sourceError.message : null;
  try {
    if (!cachedOnly) {
      try { complete = syncPlatformRange_(date, to).complete; }
      catch (error) { warning = recordHealineFailure_(error).message; complete = false; }
    }
    if (calendarPaused) {
      if (!complete) throw new Error('provider_retry_required');
      state.sourceDates = Array.from(new Set((state.sourceDates || []).concat([date])));
      state.lastSourceCollection = { date: date, completedAt: new Date().toISOString() };
      props.setProperty(HEALINE.propertyKeys.calendarBackfill, JSON.stringify(state));
      var sourceResult = { date: date, sourceOnly: true, remainingDates: state.dates.length,
        calendarDeferredUntil: new Date(state.calendarRetryAt).toISOString() };
      console.log(JSON.stringify(sourceResult));
      return sourceResult;
    }
    // Historical comparisons must load dates BEFORE the target, not today's baseline.
    var from = addIsoDays_(date, -HEALINE.baselineDays);
    phase = 'read_history';
    var history = readPlatformObservations_(from, to);
    phase = 'build_reference';
    var baseline = buildBaseline_(history, from, date);
    history.syncWarning = warning;
    phase = 'write_calendar';
    var written = writeHealineRange_({ start: new Date(localDayStartMs_(date)),
      end: new Date(localDayStartMs_(to)) }, history, baseline);
    phase = 'source_completion';
    if (!complete) throw new Error('provider_retry_required');
    if (queued) state.dates = state.dates.filter(function (d) { return d !== date; });
    state.sourceDates = (state.sourceDates || []).filter(function (d) { return d !== date; });
    delete state.failures[date];
    props.setProperty(HEALINE.propertyKeys.calendarSweepDate, to);
    props.setProperty(HEALINE.propertyKeys.calendarBackfill, JSON.stringify(state));
    if (!cachedOnly && date >= addIsoDays_(today, -HEALINE.baselineDays)) {
      props.setProperty(HEALINE.propertyKeys.baselineDirty, '1');
      props.deleteProperty(HEALINE.propertyKeys.baselineAttemptDate);
    }
    var result = { date: date, hourlyRecordCount: written.hourlyRecordCount, cachedOnly: Boolean(cachedOnly),
      completedAt: new Date().toISOString(), remainingDates: state.dates.length };
    props.setProperty(HEALINE.propertyKeys.lastBackfill, JSON.stringify(result));
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    if (state.dates.indexOf(date) < 0) state.dates.push(date);
    var attempts = (state.failures[date] || {}).attempts || 0;
    var message = String(error.message || error).slice(0, 300);
    state.failures[date] = { attempts: attempts + 1, phase: phase,
      retryAt: Date.now() + Math.min(6 * 3600000, 900000 * Math.pow(2, attempts)) };
    // Keep one detailed error so even 60 failed dates fit a 9KB property.
    state.lastFailure = { date: date, phase: phase, message: message, at: new Date().toISOString() };
    var calendarLimited = phase === 'write_calendar' && isCalendarRateLimit_(message);
    if (calendarLimited) state.calendarRetryAt = state.failures[date].retryAt;
    props.setProperty(HEALINE.propertyKeys.calendarBackfill, JSON.stringify(state));
    console.warn('과거 날짜 보충 보류: ' + date + ' [' + phase + '] ' + message);
    return { date: date, pending: true, phase: phase, calendarLimited: calendarLimited };
  }
}

// Operators can replay retained records while Polar authorization is unavailable.
function replayStoredHealineCalendar() { return continueHealineBackfill_(true); }
function continueHealineBackfill() { return continueHealineBackfill_(false); }
function continueHealineBackfill_(cachedOnly) {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) return { busy: true };
  try {
    if (!cachedOnly) applyPendingHealineCatchup_();
    var deadline = Date.now() + 240000, results = [];
    for (var i = 0; i < 4 && Date.now() < deadline; i += 1) {
      var result = reconcileHistoricalDay_(cachedOnly, results.map(function (r) { return r.date; }));
      if (!result) break;
      results.push(result);
      if (result.calendarLimited) break;
    }
    return results;
  } finally { lock.releaseLock(); }
}

// Use the installation's fixed ingress without rotating collector or Polar credentials.
function repairHealinePlatformConnection() {
  var props = PropertiesService.getUserProperties();
  var previous = props.getProperty(HEALINE.propertyKeys.platformUrl);
  props.setProperty(HEALINE.propertyKeys.platformUrl, HEALINE.platformOrigin);
  try {
    var today = formatIsoDate_(new Date());
    readPlatformObservations_(addIsoDays_(today, -1), today);
  } catch (error) {
    if (previous) props.setProperty(HEALINE.propertyKeys.platformUrl, previous);
    else props.deleteProperty(HEALINE.propertyKeys.platformUrl);
    throw error;
  }
  console.log('고정된 Healine 서버 연결을 확인했습니다.');
  return queueHealineBackfill();
}
