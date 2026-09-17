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
    var now = new Date();
    var today = formatIsoDate_(now);
    var range = {
      start: new Date(localDayStartMs_(addIsoDays_(today, -1))),
      end: previousCompleteWindow_(now).end
    };
    var data = fetchPolarWindowData_(range);
    var properties = PropertiesService.getUserProperties();
    var baseline = getBaseline_();
    if ((!baseline || baseline.version !== HEALINE.modelVersion) &&
        properties.getProperty(HEALINE.propertyKeys.baselineAttemptDate) !== today) {
      try { baseline = rebuildBaseline(); }
      catch (error) { console.warn('개인 기준 누적 중: ' + error.message); }
    }
    var windows = [];
    for (var start = range.start.getTime(); start < range.end.getTime(); start += 900000) {
      windows.push(evaluateHealineWindow_({
        windowStartMs: start, windowEndMs: start + 900000,
        heartRateSamples: data.heartRateSamples, metSamples: data.metSamples,
        stepSamples: data.stepSamples, baseline: baseline, sleeps: data.sleeps
      }));
    }
    var calendar = getOrCreateHealineCalendar_();
    // Fetch once; repeated runs update existing tags instead of creating duplicates.
    var events = calendar.getEvents(range.start, new Date(localDayStartMs_(addIsoDays_(today, 1))));
    var hours = buildHourlyObservations_(windows);
    var writtenHours = {};
    hours.forEach(function (hour) {
      if (hour.heartRateSampleCount === 0 && !(hour.steps > 0) && hour.activeMinutes === 0) return;
      upsertHealineHour_(calendar, events, hour);
      writtenHours[hourKey_(hour.startMs)] = true;
    });
    var dates = isoDatesBetween_(formatIsoDate_(range.start), addIsoDays_(today, 1));
    var summaries = dates.map(function (date) {
      var summary = buildDailySummary_(date, windows, data);
      upsertHealineDay_(calendar, events, summary);
      if (summary.sleep) upsertHealineSleep_(calendar, events, summary.sleep);
      return summary;
    });
    var removed = cleanupLegacyHealineEvents_(events, writtenHours, HEALINE.legacyCleanupLimit);
    var stored = {
      version: HEALINE.modelVersion, completedAt: now.toISOString(),
      processedWindowCount: windows.length, hourlyRecordCount: Object.keys(writtenHours).length,
      summaryDates: dates, latestHeartRateAt: summaries[summaries.length - 1].lastHeartRateAt,
      sleepAccess: data.sleepAccess, legacyEventsRemoved: removed,
      source: data.source || 'apps-script',
      baselineDays: baseline && baseline.version === 2 ? Object.keys(baseline.days).length : 0
    };
    properties.setProperty(HEALINE.propertyKeys.lastResult, JSON.stringify(stored));
    console.log(JSON.stringify(stored));
    try { backfillPlatformDay_(); }
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
  var status = {
    configured: Boolean(config.clientId && config.clientSecret && config.redirectUri),
    polarAuthorized: Boolean(properties.getProperty(HEALINE.propertyKeys.refreshToken)),
    calendarName: config.calendarName,
    platformConnected: isHealinePlatformConnected_(),
    baselineVersion: baseline && baseline.version,
    baselineDays: baseline && baseline.days ? Object.keys(baseline.days).length : 0,
    sleepAccess: properties.getProperty(HEALINE.propertyKeys.sleepAccess),
    triggers: ScriptApp.getProjectTriggers().map(function (trigger) { return trigger.getHandlerFunction(); }),
    lastResult: JSON.parse(properties.getProperty(HEALINE.propertyKeys.lastResult) || 'null')
  };
  console.log(JSON.stringify(status, null, 2));
  return status;
}
