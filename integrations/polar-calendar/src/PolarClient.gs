function polarGet_(path, parameters, options) {
  options = options || {};
  var url = HEALINE.apiBaseUrl + path;
  if (parameters && Object.keys(parameters).length) url += '?' + encodeQuery_(parameters);

  var response = fetchPolarWithToken_(url, getValidPolarAccessToken_());
  if (response.getResponseCode() === 401 && !options.didRetry) {
    var userProperties = PropertiesService.getUserProperties();
    userProperties.deleteProperty(HEALINE.propertyKeys.accessToken);
    response = fetchPolarWithToken_(url, refreshPolarToken_());
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
    syncPlatformRange_(from, to);
    return readPlatformObservations_(from, to);
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
    (response.data && response.data.continuousSamples) || response;
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
    (response.data && response.data.activities));
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
      score: score !== null && score >= 1 && score <= 100 ? round_(score, 1) : null
    };
  }).filter(function (sleep) { return sleep !== null; });
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

function syncPlatformRange_(from, to) {
  isoDatesBetween_(from, to).forEach(function (date) {
    [
      { kind: 'heart_rate', path: '/continuous-samples', features: 'heart-rate-samples' },
      { kind: 'activity', path: '/activity/list', features: 'samples' },
      { kind: 'sleep', path: '/sleeps', features: ['sleep-result', 'sleep-score'] },
      { kind: 'recovery', path: '/nightly-recharge-results' }
    ].forEach(function (request) {
      var query = { from: date, to: addIsoDays_(date, 1) };
      if (request.features) query.features = request.features;
      var url = HEALINE.apiBaseUrl + request.path + '?' + encodeQuery_(query);
      var response = fetchPolarWithToken_(url, getValidPolarAccessToken_());
      if (response.getResponseCode() === 401) response = fetchPolarWithToken_(url, refreshPolarToken_());
      var body;
      try { body = JSON.parse(response.getContentText() || '{}'); }
      catch (ignored) { body = { responseFormat: 'non-json' }; }
      // Resource responses only. OAuth credentials never leave Apps Script.
      var batch = platformRequest_('/batches', {
        kind: request.kind, date: date, fetched_at: new Date().toISOString(),
        http_status: response.getResponseCode(), payload: body
      });
      if (batch.status === 'processing_error' || batch.status === 'pending') {
        throw new Error('Healine에 원본을 저장했지만 처리 중입니다. 다음 실행에서 다시 확인합니다.');
      }
    });
  });
}

function readPlatformObservations_(from, to) {
  var data = platformRequest_('/observations?' + encodeQuery_({ from: from, to: to }));
  if (data.source !== 'healine-platform' || !Array.isArray(data.heartRateSamples) ||
      !Array.isArray(data.metSamples) || !Array.isArray(data.stepSamples)) {
    throw new Error('Healine 관측 응답 형식을 확인할 수 없습니다.');
  }
  return data;
}

function backfillPlatformDay_() {
  if (!isHealinePlatformConnected_()) return;
  var props = PropertiesService.getUserProperties();
  var date = props.getProperty(HEALINE.propertyKeys.platformBackfillDate);
  var yesterday = addIsoDays_(formatIsoDate_(new Date()), -1);
  if (!date || date >= yesterday) return;
  syncPlatformRange_(date, addIsoDays_(date, 1));
  props.setProperty(HEALINE.propertyKeys.platformBackfillDate, addIsoDays_(date, 1));
}
