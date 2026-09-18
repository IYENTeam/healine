var HEALINE = Object.freeze({
  timezone: 'Asia/Seoul',
  timezoneOffset: '+09:00',
  apiBaseUrl: 'https://www.polaraccesslink.com/v4/data',
  authorizationUrl: 'https://auth.polar.com/oauth/authorize',
  tokenUrl: 'https://auth.polar.com/oauth/token',
  scopes: [
    'continuous_samples:read',
    'activity:read',
    'nightly_recharge:read',
    'sleep:read'
  ],
  calendarName: 'Healine 상태',
  calendarId: 'f5323b2dbd20de99724fec1d9d245452e60c0fc9e458829f542ad4651b492d9b@group.calendar.google.com',
  windowMinutes: 15,
  baselineDays: 14,
  modelVersion: 2,
  baselineMinDays: 5,
  baselineMinWindows: 12,
  minimumMetMinutes: 12,
  minimumHeartRateSamples: 2,
  recentActivityMinutes: 30,
  comparisonStartHour: 8,
  comparisonEndHour: 22,
  propertyKeys: Object.freeze({
    clientId: 'POLAR_CLIENT_ID',
    clientSecret: 'POLAR_CLIENT_SECRET',
    redirectUri: 'POLAR_REDIRECT_URI',
    calendarName: 'HEALINE_CALENDAR_NAME',
    baseline: 'HEALINE_BASELINE_JSON',
    baselineAttemptDate: 'HEALINE_BASELINE_ATTEMPT_DATE',
    grantedScopes: 'POLAR_GRANTED_SCOPES',
    sleepAccess: 'HEALINE_SLEEP_ACCESS',
    accessToken: 'POLAR_ACCESS_TOKEN',
    refreshToken: 'POLAR_REFRESH_TOKEN',
    expiresAt: 'POLAR_EXPIRES_AT',
    oauthState: 'POLAR_OAUTH_STATE',
    oauthStateExpiresAt: 'POLAR_OAUTH_STATE_EXPIRES_AT',
    lastResult: 'HEALINE_LAST_RESULT',
    platformUrl: 'HEALINE_PLATFORM_URL',
    platformKey: 'HEALINE_PLATFORM_COLLECTOR_KEY',
    platformBackfillDate: 'HEALINE_PLATFORM_BACKFILL_DATE'
  })
});

function getHealineConfig_() {
  var properties = PropertiesService.getScriptProperties();
  var deployedUrl = ScriptApp.getService().getUrl();


  return {
    clientId: properties.getProperty(HEALINE.propertyKeys.clientId),
    clientSecret: properties.getProperty(HEALINE.propertyKeys.clientSecret),
    redirectUri: properties.getProperty(HEALINE.propertyKeys.redirectUri) || deployedUrl,
    calendarName:
      properties.getProperty(HEALINE.propertyKeys.calendarName) ||
      HEALINE.calendarName
  };
}

function assertHealineConfigured_() {
  var config = getHealineConfig_();
  var missing = [];

  if (!config.clientId) missing.push(HEALINE.propertyKeys.clientId);
  if (!config.clientSecret) missing.push(HEALINE.propertyKeys.clientSecret);
  if (!config.redirectUri) missing.push(HEALINE.propertyKeys.redirectUri);

  if (missing.length) {
    throw new Error('Apps Script의 Script Properties에 다음 값을 설정하세요: ' + missing.join(', '));
  }

  return config;
}
