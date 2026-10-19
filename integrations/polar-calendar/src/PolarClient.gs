function polarGet_(path, parameters, options) {
  options = options || {};
  var url = HEALINE.apiBaseUrl + path;
  if (parameters && Object.keys(parameters).length) url += '?' + encodeQuery_(parameters);

  var accessToken = getValidPolarAccessToken_();
  var response = fetchPolarWithToken_(url, accessToken);
  if (response.getResponseCode() === 401 && !options.didRetry) {
    response = fetchPolarWithToken_(url, refreshPolarToken_(accessToken));
  }

  var status = response.getResponseCode();
  var body = response.getContentText();
  if (options.allowNotFound && status === 404) return null;
  if (options.allowForbidden && status === 403) return { healineForbidden: true };
  if (status < 200 || status >= 300) {
    throw new Error('Polar API 요청 실패 (' + status + ', ' + path + '): ' + safeApiError_(body));
  }
  return body ? JSON.parse(body) : {};
}

function fetchPolarWithToken_(url, token) {
  return UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  });
}

function fetchPolarWindowData_(window) {
  var from = formatIsoDate_(window.start);
  var to = addIsoDays_(formatIsoDate_(new Date(window.end.getTime() - 1)), 1);
  if (isHealinePlatformConnected_()) {
    var receipt = syncPlatformRange_(from, to);
    var stored = readPlatformObservations_(from, to);
    if (getWorkoutAccess_() === 'needs_connection') stored.workoutAccess = 'needs_connection';
    if (receipt && !receipt.complete) stored.syncWarning = '일부 Polar 조회가 실패했습니다. 종류별 수집 상태와 측정 날짜를 확인하세요.';
    return stored;
  }
  var activity = fetchActivityRange_(from, to);
  var sleep = fetchSleepRange_(from, to);
  return {
    heartRateSamples: fetchHeartRateRange_(from, to),
    metSamples: activity.metSamples,
    stepSamples: activity.stepSamples,
    nightlyRecharges: extractNightlyRecharge_(polarGet_('/nightly-recharge-results', {
      from: from, to: to
    }, { allowNotFound: true })),
    sleeps: sleep.sleeps,
    sleepAccess: sleep.access
  };
}

function fetchHeartRateRange_(from, to) {
  return extractHeartRateSamples_(polarGet_('/continuous-samples', {
    from: from, to: to, features: 'heart-rate-samples'
  }));
}

function fetchActivityRange_(from, to) {
  var result = { metSamples: [], stepSamples: [] };
  isoDatesBetween_(from, to).forEach(function (date) {
    // AccessLink v4 allows only ONE day when activity features are requested.
    var day = extractActivityData_(polarGet_('/activity/list', {
      from: date, to: addIsoDays_(date, 1), features: 'samples'
    }, { allowNotFound: true }));
    result.metSamples = result.metSamples.concat(day.metSamples);
    result.stepSamples = result.stepSamples.concat(day.stepSamples);
  });
  return result;
}

function fetchSleepRange_(from, to) {
  var properties = PropertiesService.getUserProperties();
  var scope = properties.getProperty(HEALINE.propertyKeys.grantedScopes);
  if (properties.getProperty(HEALINE.propertyKeys.sleepAccess) === 'denied' ||
      (scope && scope.split(/\s+/).indexOf('sleep:read') < 0)) {
    return { sleeps: [], access: 'needs_connection' };
  }
  var sleeps = [];
  try {
    var dates = isoDatesBetween_(from, to);
    for (var i = 0; i < dates.length; i += 1) {
      var response = polarGet_('/sleeps', {
        from: dates[i], to: addIsoDays_(dates[i], 1), features: ['sleep-result', 'sleep-score']
      }, { allowNotFound: true, allowForbidden: true });
      if (response && response.healineForbidden) {
        properties.setProperty(HEALINE.propertyKeys.sleepAccess, 'denied');
        return { sleeps: [], access: 'needs_connection' };
      }
      sleeps = sleeps.concat(extractSleeps_(response));
    }
    properties.setProperty(HEALINE.propertyKeys.sleepAccess, 'granted');
    return { sleeps: sleeps, access: 'granted' };
  } catch (error) {
    console.warn('수면 데이터 조회 보류: ' + error.message);
    return { sleeps: sleeps, access: 'error' };
  }
}

function extractHeartRateSamples_(response) {
  if (!response) return [];
  var container = response.continuousSamples ||
    (response.data && (response.data.continuousSamples || response.data)) || response;
  var days = container.heartRateSamplesPerDay || [];
  var output = [];

  days.forEach(function (day) {
    var dayStart = localDayStartMs_(day.date);
    (day.samples || []).forEach(function (sample) {
      var heartRate = validNumber_(sample.heartRate);
      var offset = validNumber_(sample.offsetMillis);
      if (Number.isFinite(dayStart) && heartRate !== null && heartRate >= 30 && heartRate <= 220 &&
          offset !== null && offset >= 0 && offset < 86400000) {
        output.push({
          timestampMs: dayStart + offset,
          heartRate: heartRate,
          triggerType: sample.triggerType || null
        });
      }
    });
  });
  return validSamples_(output, 'heartRate', 30, 220);
}

function extractActivityData_(response) {
  var container = response && (response.activities ||
    (response.data && (response.data.activities || response.data)) || response);
  var days = (container && container.activityDays) || [];
  var metSamples = [];
  var stepSamples = [];
  var restingHeartRate = null;

  days.forEach(function (day) {
    var physical = day.physicalInformation || {};
    var resting = validNumber_(physical.restingHeartRate);
    if (resting !== null && resting > 0) restingHeartRate = resting;

    // One device per day prevents summing the same movement from two watches.
    var devices = (day.activitiesPerDevice || []).slice().sort(function (a, b) {
      return activityDeviceSize_(b) - activityDeviceSize_(a);
    });
    devices.slice(0, 1).forEach(function (device) {
      (device.activitySamples || []).forEach(function (recording) {
        appendVectorSamples_(metSamples, day.date, recording.metSamples, 'mets', 'met');
        appendVectorSamples_(stepSamples, day.date, recording.stepSamples, 'steps', 'steps');
      });
    });
  });

  return {
    metSamples: validSamples_(metSamples, 'met', 0.1, 30),
    stepSamples: validSamples_(stepSamples, 'steps', 0, 10000),
    restingHeartRate: restingHeartRate
  };
}

function appendVectorSamples_(target, date, vector, valuesKey, outputKey) {
  if (!vector || !Array.isArray(vector[valuesKey])) return;
  if (!vector.startTime) return;
  var start = localSampleTimeMs_(date, vector.startTime);
  var interval = Number(vector.interval);
  if (!Number.isFinite(start) || !Number.isFinite(interval) || interval <= 0) return;

  vector[valuesKey].forEach(function (value, index) {
    var parsed = validNumber_(value);
    if (parsed === null || parsed < 0 || (outputKey === 'met' && parsed === 0)) return;
    var sample = { timestampMs: start + index * interval, intervalMs: interval };
    sample[outputKey] = parsed;
    target.push(sample);
  });
}

function extractNightlyRecharge_(response) {
  if (!response) return [];
  var outer = response.nightlyRechargeResults ||
    (response.data && response.data.nightlyRechargeResults);
  if (!outer) return [];
  return Array.isArray(outer) ? outer : (outer.nightlyRechargeResults || []);
}

function activityDeviceSize_(device) {
  return (device.activitySamples || []).reduce(function (count, recording) {
    return count + ((recording.metSamples || {}).mets || []).length +
      ((recording.stepSamples || {}).steps || []).length;
  }, 0);
}

function extractSleeps_(response) {
  var nights = response && (response.nightSleeps || (response.data && response.data.nightSleeps)) || [];
  return nights.map(function (night) {
    var hypnogram = (night.sleepResult || {}).hypnogram || {};
    var start = Date.parse(hypnogram.sleepStart);
    var end = Date.parse(hypnogram.sleepEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 86400000) return null;
    var score = validNumber_((night.sleepScore || {}).sleepScore);
    return {
      date: night.sleepDate, startMs: start, endMs: end,
      durationMinutes: Math.round((end - start) / 60000),
      score: score !== null && score >= 1 && score <= 100 ? round_(score, 1) : null,
      scores: sleepScoreComponents_(night.sleepScore || {})
    };
  }).filter(function (sleep) { return sleep !== null; });
}

function sleepScoreComponents_(score) {
  var output = {};
  ['continuityScore', 'efficiencyScore', 'longInterruptionsTimeScore', 'groupSolidityScore',
    'groupDurationScore', 'groupRefreshScore', 'n3Score', 'remScore'].forEach(function (key) {
    var value = validNumber_(score[key]);
    output[key] = value !== null && value >= 0 && value <= 100 ? value : null;
  });
  return output;
}

function isHealinePlatformConnected_() {
  var props = PropertiesService.getUserProperties();
  return Boolean(props.getProperty(HEALINE.propertyKeys.platformUrl) &&
    props.getProperty(HEALINE.propertyKeys.platformKey));
}

function platformRequest_(path, payload) {
  var props = PropertiesService.getUserProperties();
  var base = props.getProperty(HEALINE.propertyKeys.platformUrl);
  var key = props.getProperty(HEALINE.propertyKeys.platformKey);
  if (!base || !key) throw new Error('Healine 플랫폼을 먼저 연결하세요.');
  var options = {
    method: payload ? 'post' : 'get', contentType: 'application/json',
    headers: { 'X-Healine-Collector-Key': key }, muteHttpExceptions: true,
    followRedirects: false
  };
  if (payload) options.payload = JSON.stringify(payload);
  var response = UrlFetchApp.fetch(base + '/api/v1/collectors' + path, options);
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error('Healine 플랫폼 요청 실패 (' + response.getResponseCode() + '). 기존 캘린더 기록은 유지됩니다.');
  }
  return JSON.parse(response.getContentText());
}

function syncPlatformRange_(from, to, kinds) {
  var complete = true;
  isoDatesBetween_(from, to).forEach(function (date) {
    [
      { kind: 'heart_rate', path: '/continuous-samples', features: 'heart-rate-samples' },
      { kind: 'activity', path: '/activity/list', features: 'samples' },
      { kind: 'sleep', path: '/sleeps', features: ['sleep-result', 'sleep-score'] },
      { kind: 'recovery', path: '/nightly-recharge-results' },
      { kind: 'workout', path: '/training-sessions/list',
        features: ['samples', 'statistics', 'zones', 'training-load-report', 'laps', 'pause-times', 'strength-training-results'] },
      // Added measurements: requested only after their scope was explicitly granted and never
      // allowed to hold back the core resources' completion.
      { kind: 'test', path: '/tests/list', scope: 'tests:read' },
      { kind: 'skin_contact', path: '/skin-contacts', scope: 'skin_contact:read' },
      { kind: 'temperature', path: '/temperature-measurements', scope: 'temperature_measurement:read' },
      { kind: 'ppi', path: '/ppi-samples', features: 'samples', scope: 'ppi_data:read' }
    ].forEach(function (request) {
      if (kinds && kinds.indexOf(request.kind) < 0) return;
      if (request.kind === 'workout' && getWorkoutAccess_() === 'needs_connection') return;
      if (request.scope && !hasGrantedPolarScope_(request.scope)) return;
      var query = { from: date, to: addIsoDays_(date, 1) };
      // Training sessions require local ISO datetimes, not date-only values.
      // Keep the provider-local day and its exclusive next-midnight boundary.
      if (request.kind === 'workout') {
        query.from += 'T00:00:00';
        query.to += 'T00:00:00';
      }
      if (request.features) query.features = request.features;
      var response = fetchPolarSource_(request.path, query);
      if (request.scope && response.getResponseCode() === 400 && /datetime/i.test(response.getContentText() || '')) {
        // Same contract wording as training sessions, which reject date-only values.
        query.from += 'T00:00:00';
        query.to += 'T00:00:00';
        response = fetchPolarSource_(request.path, query);
      }
      var body;
      try { body = JSON.parse(response.getContentText() || '{}'); }
      catch (ignored) { body = { responseFormat: 'non-json' }; }
      var httpStatus = response.getResponseCode();
      if (request.kind === 'workout') {
        PropertiesService.getUserProperties().setProperty(HEALINE.propertyKeys.workoutAccess,
          httpStatus === 403 ? 'needs_connection' : httpStatus === 200 ? 'granted' : 'error');
        if (httpStatus === 200) body = enrichWorkoutSports_(body);
      }
      if (request.kind === 'ppi' && httpStatus === 200) body = compactPpiResponse_(body);
      // Resource responses only. OAuth credentials never leave Apps Script.
      var batch = platformRequest_('/batches', {
        kind: request.kind, date: date, fetched_at: new Date().toISOString(),
        http_status: httpStatus, payload: body
      });
      if (!request.scope && (batch.status === 'processing_error' || batch.status === 'pending')) {
        throw new Error('Healine에 원본을 저장했지만 처리 중입니다. 다음 실행에서 다시 확인합니다.');
      }
      // Missing optional workout consent must not stop the already-authorized resources.
      if (request.kind === 'workout' && httpStatus === 403) return;
      if (request.scope) return;
      if (['processed', 'empty'].indexOf(batch.status) < 0 &&
          (request.kind === 'workout' || httpStatus !== 404)) complete = false;
    });
  });
  return { complete: complete };
}

function fetchPolarSource_(path, query) {
  var url = HEALINE.apiBaseUrl + path + '?' + encodeQuery_(query);
  var accessToken = getValidPolarAccessToken_();
  var response = fetchPolarWithToken_(url, accessToken);
  if (response.getResponseCode() === 401) response = fetchPolarWithToken_(url, refreshPolarToken_(accessToken));
  return response;
}

function hasGrantedPolarScope_(scope) {
  var scopes = PropertiesService.getUserProperties().getProperty(HEALINE.propertyKeys.grantedScopes);
  return Boolean(scopes) && scopes.split(/\s+/).indexOf(scope) >= 0;
}

function missingExtendedScopes_() {
  return HEALINE.extendedScopes.filter(function (scope) { return !hasGrantedPolarScope_(scope); });
}

// A PPI day can hold tens of thousands of beats. Columns keep every sample's offset, interval,
// error estimate and skin-contact/movement/offline flags (1/2/4; absent flags count as false)
// within the platform's delivery size limit.
function compactPpiResponse_(body) {
  var root = body.data || body;
  if (!Array.isArray(root.dailyPpiSamples)) return body;
  return { healinePpiColumns: { version: 1, days: root.dailyPpiSamples.map(function (day) {
    return { date: day.date, modified: day.modified || null, devices: (day.ppiSamplesPerDevice || []).map(function (device) {
      var columns = { recordingDevice: device.recordingDevice || null,
        recordingTriggerTypeChanges: device.recordingTriggerTypeChanges || [],
        offsetMillis: [], ppInterval: [], errorEstimateMillis: [], flags: [] };
      (device.ppiSamples || []).forEach(function (sample) {
        columns.offsetMillis.push(sample.offsetMillis);
        columns.ppInterval.push(sample.ppInterval);
        columns.errorEstimateMillis.push(sample.errorEstimateMillis);
        columns.flags.push((sample.skinContact === true ? 1 : 0) | (sample.movement === true ? 2 : 0) |
          (sample.offline === true ? 4 : 0));
      });
      return columns;
    }) };
  }) } };
}

function getWorkoutAccess_() {
  var props = PropertiesService.getUserProperties();
  var scopes = props.getProperty(HEALINE.propertyKeys.grantedScopes);
  if (scopes && scopes.split(/\s+/).indexOf('training_sessions:read') < 0) return 'needs_connection';
  return props.getProperty(HEALINE.propertyKeys.workoutAccess) || 'unknown';
}

function enrichWorkoutSports_(body) {
  var root = body.data || body;
  if (!Array.isArray(root.trainingSessions) || !root.trainingSessions.length) return body;
  var scopes = PropertiesService.getUserProperties().getProperty(HEALINE.propertyKeys.grantedScopes);
  // The status explains a missing sport name in the retained response.
  if (scopes && scopes.split(/\s+/).indexOf('sports:read') < 0) { root.healineSportCatalogStatus = 'no_scope'; return body; }
  try {
    var cache = CacheService.getScriptCache(), cached = cache.get('healine_sports_v1');
    var catalog = cached ? JSON.parse(cached) : null;
    if (!catalog) {
      var response = polarGet_('/sports/list', {}, { allowForbidden: true });
      if (response.healineForbidden) { root.healineSportCatalogStatus = 'forbidden'; return body; }
      // The live gateway's shape differs from the published contract; accept the known wrappers.
      var raw = response.data !== undefined ? response.data : response;
      var sports = Array.isArray(raw) ? raw : raw && Array.isArray(raw.sports) ? raw.sports :
        raw && raw.data && Array.isArray(raw.data.sports) ? raw.data.sports : null;
      if (!sports) {
        throw new Error('운동 종목 응답 형식 확인 필요 (keys: ' +
          Object.keys(raw && typeof raw === 'object' ? raw : {}).slice(0, 8).join(',') + ')');
      }
      var idOf = function (ref) { return ref && typeof ref === 'object' ? ref.id : ref; };
      var names = {}; sports.forEach(function (s) { names[idOf(s.id)] = s.name; });
      catalog = {};
      sports.forEach(function (s) {
        var labels = s.localizedNames || {};
        catalog[idOf(s.id)] = { name: s.name, parentName: names[idOf(s.parentSport)],
          label: (labels.ko || labels['ko-KR'] || labels.en || {}).longName || s.name };
      });
      try { cache.put('healine_sports_v1', JSON.stringify(catalog), 21600); }
      catch (cacheError) { console.warn('운동 종목 목록 캐시 생략: ' + cacheError.message); }
    }
    var selected = {};
    root.trainingSessions.forEach(function (session) {
      [session].concat(session.exercises || []).forEach(function (exercise) {
        var id = (exercise.sport || {}).id;
        if (id && catalog[id]) selected[id] = catalog[id];
      });
    });
    // Supplemental public catalog; the original training-session fields are retained.
    root.healineSportCatalog = selected;
    root.healineSportCatalogStatus = 'ok';
  } catch (error) {
    root.healineSportCatalogStatus = 'error: ' + String(error.message || error).slice(0, 200);
    console.warn('운동 종목 이름 조회 보류. 원본 종목 ID는 보존합니다.');
  }
  return body;
}

function readPlatformObservations_(from, to) {
  var data = platformRequest_('/observations?' + encodeQuery_({ from: from, to: to }));
  if (data.source !== 'healine-platform' || !Array.isArray(data.heartRateSamples) ||
      !Array.isArray(data.metSamples) || !Array.isArray(data.stepSamples)) {
    throw new Error('Healine 관측 응답 형식을 확인할 수 없습니다.');
  }
  return data;
}
