function doGet(event) {
  try {
    if (event && event.parameter && event.parameter.platform_setup === '1') {
      return renderPlatformSetupPage_(event.parameter.platform_url || '');
    }
    if (event && event.parameter && event.parameter.error) {
      return HtmlService.createHtmlOutput(
        '<h2>Polar 연결 실패</h2><p>' + escapeHtml_(event.parameter.error) + '</p>'
      );
    }

    if (event && event.parameter && event.parameter.code) {
      verifyOauthState_(event.parameter.state);
      exchangeAuthorizationCode_(event.parameter.code);
      var setupMessage = '캘린더와 15분 자동 기록 설정도 완료했습니다.';
      try {
        setup();
      } catch (setupError) {
        setupMessage = 'Polar 연결은 완료했습니다. 자동 설정 중 확인할 항목이 생겼습니다: ' +
          setupError.message;
      }
      return HtmlService.createHtmlOutput(
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<div style="max-width:680px;margin:40px auto;font:16px system-ui;line-height:1.55">' +
          '<h2>Polar 연결 완료</h2><p>' + escapeHtml_(setupMessage) + '</p>' +
          '<p>Google Calendar에서 <b>Healine 상태</b> 캘린더를 확인하세요.</p></div>'
      );
    }

    var config = getHealineConfig_();
    if ((event && event.parameter && event.parameter.configure === '1') ||
        !config.clientId || !config.clientSecret || !config.redirectUri) {
      return renderPolarSetupPage_(config.redirectUri);
    }
    return renderPolarConnectPage_();
  } catch (error) {
    return HtmlService.createHtmlOutput(
      '<h2>설정 확인 필요</h2><pre>' + escapeHtml_(error.message) + '</pre>'
    );
  }
}

function doPost(event) {
  try {
    var parameters = (event && event.parameter) || {};
    if (parameters.platform_pair === '1') return connectHealinePlatform_(parameters);
    verifySetupNonce_(parameters.setup_nonce);

    var clientId = String(parameters.client_id || '').trim();
    var clientSecret = String(parameters.client_secret || '').trim();
    var redirectUri = ScriptApp.getService().getUrl();
    if (clientId.length < 8 || clientSecret.length < 8 || !redirectUri) {
      throw new Error('Client ID, Client Secret 또는 배포 URL을 확인하세요.');
    }

    var values = {};
    values[HEALINE.propertyKeys.clientId] = clientId;
    values[HEALINE.propertyKeys.clientSecret] = clientSecret;
    values[HEALINE.propertyKeys.redirectUri] = redirectUri;
    PropertiesService.getScriptProperties().setProperties(values);
    return renderPolarConnectPage_();
  } catch (error) {
    return HtmlService.createHtmlOutput(
      '<h2>설정 저장 실패</h2><pre>' + escapeHtml_(error.message) + '</pre>' +
        '<p><a href="' + escapeHtml_(ScriptApp.getService().getUrl() || '') + '">다시 시도</a></p>'
    );
  }
}

function renderPolarSetupPage_(redirectUri) {
  var nonce = Utilities.getUuid();
  PropertiesService.getUserProperties().setProperty('HEALINE_SETUP_NONCE', nonce);
  var safeRedirect = escapeHtml_(redirectUri || '웹 앱 배포 URL을 확인하세요');
  return HtmlService.createHtmlOutput(
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<div style="max-width:680px;margin:40px auto;font:16px system-ui;line-height:1.55">' +
      '<h2>Healine · Polar Vantage V3 설정</h2>' +
      '<p>Polar AccessLink Admin에서 API Client를 만든 뒤 아래 값을 입력하세요.</p>' +
      '<p><b>Authorization redirect URL</b><br><code style="word-break:break-all">' + safeRedirect + '</code></p>' +
      '<form method="post" action="' + safeRedirect + '" target="_top">' +
      '<input type="hidden" name="setup_nonce" value="' + escapeHtml_(nonce) + '">' +
      '<label>Client ID<br><input required name="client_id" autocomplete="off" style="width:100%;padding:8px"></label><br><br>' +
      '<label>Client Secret<br><input required type="password" name="client_secret" autocomplete="new-password" style="width:100%;padding:8px"></label><br><br>' +
      '<button style="padding:10px 16px">안전하게 저장하고 계속</button>' +
      '</form><p style="color:#666;font-size:13px">Secret은 Google Apps Script의 비공개 Script Properties에 저장되며 이 페이지에 다시 표시되지 않습니다.</p>' +
      '</div>'
  );
}

function renderPolarConnectPage_() {
  var url = getPolarAuthorizationUrl();
  return HtmlService.createHtmlOutput(
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<div style="max-width:680px;margin:40px auto;font:16px system-ui;line-height:1.55">' +
      '<h2>Healine · Polar Vantage V3</h2>' +
      '<p>아래 버튼으로 Polar Flow 데이터 접근을 허용하세요.</p>' +
      '<p><a style="display:inline-block;padding:12px 18px;background:#d71920;color:white;' +
      'text-decoration:none;border-radius:6px" target="_top" href="' + escapeHtml_(url) + '">Polar 연결</a></p>' +
      '<p>요청 권한: 연속 심박수, 활동량, Nightly Recharge, 수면 읽기</p>' +
      '<p>기존 연결은 유지됩니다. 수면 시간도 표시하려면 위 버튼으로 다시 연결하세요.</p></div>'
  );
}

function verifySetupNonce_(receivedNonce) {
  var properties = PropertiesService.getUserProperties();
  var expectedNonce = properties.getProperty('HEALINE_SETUP_NONCE');
  properties.deleteProperty('HEALINE_SETUP_NONCE');
  if (!receivedNonce || !expectedNonce || receivedNonce !== expectedNonce) {
    throw new Error('설정 페이지가 만료되었습니다. 다시 열어 입력하세요.');
  }
}

function getPolarAuthorizationUrl() {
  var config = assertHealineConfigured_();
  var state = Utilities.getUuid();
  var userProperties = PropertiesService.getUserProperties();
  userProperties.setProperties({
    POLAR_OAUTH_STATE: state,
    POLAR_OAUTH_STATE_EXPIRES_AT: String(Date.now() + 10 * 60 * 1000)
  });

  return HEALINE.authorizationUrl + '?' + encodeQuery_({
    client_id: config.clientId,
    response_type: 'code',
    scope: HEALINE.scopes.join(' '),
    redirect_uri: config.redirectUri,
    state: state
  });
}

function verifyOauthState_(receivedState) {
  var properties = PropertiesService.getUserProperties();
  var expectedState = properties.getProperty(HEALINE.propertyKeys.oauthState);
  var expiresAt = Number(properties.getProperty(HEALINE.propertyKeys.oauthStateExpiresAt) || 0);
  properties.deleteProperty(HEALINE.propertyKeys.oauthState);
  properties.deleteProperty(HEALINE.propertyKeys.oauthStateExpiresAt);

  if (!receivedState || !expectedState || receivedState !== expectedState || Date.now() > expiresAt) {
    throw new Error('OAuth state가 일치하지 않거나 만료되었습니다. 처음부터 다시 연결하세요.');
  }
}

function exchangeAuthorizationCode_(code) {
  var config = assertHealineConfigured_();
  var token = requestPolarToken_({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: config.redirectUri
  });
  PropertiesService.getUserProperties().deleteProperty(HEALINE.propertyKeys.sleepAccess);
  PropertiesService.getUserProperties().deleteProperty(HEALINE.propertyKeys.grantedScopes);
  savePolarToken_(token);
}

function getValidPolarAccessToken_() {
  var properties = PropertiesService.getUserProperties();
  var accessToken = properties.getProperty(HEALINE.propertyKeys.accessToken);
  var expiresAt = Number(properties.getProperty(HEALINE.propertyKeys.expiresAt) || 0);

  if (accessToken && Date.now() < expiresAt - 5 * 60 * 1000) return accessToken;
  return refreshPolarToken_();
}

function refreshPolarToken_() {
  var properties = PropertiesService.getUserProperties();
  var refreshToken = properties.getProperty(HEALINE.propertyKeys.refreshToken);
  if (!refreshToken) {
    throw new Error('Polar 인증이 없습니다. 배포한 웹 앱 URL을 열어 먼저 연결하세요.');
  }

  var token = requestPolarToken_({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });
  savePolarToken_(token);
  return token.access_token;
}

function requestPolarToken_(payload) {
  var config = assertHealineConfigured_();
  var basic = Utilities.base64Encode(config.clientId + ':' + config.clientSecret);
  var response = UrlFetchApp.fetch(HEALINE.tokenUrl, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    headers: {
      Authorization: 'Basic ' + basic,
      Accept: 'application/json'
    },
    payload: payload,
    muteHttpExceptions: true
  });
  var status = response.getResponseCode();
  var body = response.getContentText();

  if (status < 200 || status >= 300) {
    throw new Error('Polar token 요청 실패 (' + status + '): ' + safeApiError_(body));
  }

  var parsed = JSON.parse(body);
  if (!parsed.access_token) throw new Error('Polar token 응답에 access_token이 없습니다.');
  return parsed;
}

function savePolarToken_(token) {
  var properties = PropertiesService.getUserProperties();
  var values = {};
  values[HEALINE.propertyKeys.accessToken] = token.access_token;
  values[HEALINE.propertyKeys.expiresAt] = String(
    Date.now() + Number(token.expires_in || 43199) * 1000
  );
  if (token.refresh_token) values[HEALINE.propertyKeys.refreshToken] = token.refresh_token;
  if (token.scope) {
    values[HEALINE.propertyKeys.grantedScopes] = String(token.scope);
    values[HEALINE.propertyKeys.sleepAccess] = String(token.scope).split(/\s+/).indexOf('sleep:read') >= 0
      ? 'granted' : 'denied';
  }
  properties.setProperties(values);
}

function resetPolarAuthorization() {
  var properties = PropertiesService.getUserProperties();
  [
    HEALINE.propertyKeys.accessToken,
    HEALINE.propertyKeys.refreshToken,
    HEALINE.propertyKeys.expiresAt,
    HEALINE.propertyKeys.grantedScopes,
    HEALINE.propertyKeys.sleepAccess,
    HEALINE.propertyKeys.oauthState,
    HEALINE.propertyKeys.oauthStateExpiresAt
  ].forEach(function (key) {
    properties.deleteProperty(key);
  });
  console.log('저장된 Polar 토큰을 삭제했습니다.');
}

function encodeQuery_(values) {
  return Object.keys(values)
    .map(function (key) {
      var entries = Array.isArray(values[key]) ? values[key] : [values[key]];
      return entries.map(function (value) {
        return encodeURIComponent(key) + '=' + encodeURIComponent(value);
      }).join('&');
    })
    .join('&');
}

function escapeHtml_(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeApiError_(body) {
  try {
    var parsed = JSON.parse(body);
    return parsed.error_description || parsed.errorMessage || parsed.error || '알 수 없는 오류';
  } catch (ignored) {
    return String(body || '알 수 없는 오류').slice(0, 300);
  }
}

function renderPlatformSetupPage_(suggestedUrl) {
  var props = PropertiesService.getUserProperties();
  var nonce = Utilities.getUuid();
  props.setProperty('HEALINE_PLATFORM_SETUP_NONCE', nonce);
  var url = suggestedUrl || props.getProperty(HEALINE.propertyKeys.platformUrl) || '';
  return HtmlService.createHtmlOutput(
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="max-width:680px;margin:40px auto;font:16px system-ui;line-height:1.6">' +
    '<h2>Healine 플랫폼 연결</h2>' +
    '<p>기존 Polar 인증과 캘린더는 유지하고, 수집한 건강 데이터를 아래 Healine 서버에 저장합니다.</p>' +
    '<form method="post" target="_top" action="' + escapeHtml_(ScriptApp.getService().getUrl()) + '">' +
    '<input type="hidden" name="platform_pair" value="1">' +
    '<input type="hidden" name="platform_nonce" value="' + escapeHtml_(nonce) + '">' +
    '<label>Healine 서버 주소<br><input type="url" required name="platform_url" value="' + escapeHtml_(url) +
    '" style="width:100%;padding:8px"></label><br><br>' +
    '<label>Healine에서 발급한 연결 코드<br><input required name="pairing_code" autocomplete="off" ' +
    'style="width:100%;padding:8px"></label><br><br>' +
    '<button style="padding:10px 16px">이 서버에 연결</button></form>' +
    '<p>연결 코드는 15분 동안 한 번만 사용할 수 있습니다. Polar 비밀번호나 API Secret을 입력하지 마세요.</p></div>'
  );
}

function connectHealinePlatform_(parameters) {
  var props = PropertiesService.getUserProperties();
  var nonce = props.getProperty('HEALINE_PLATFORM_SETUP_NONCE');
  props.deleteProperty('HEALINE_PLATFORM_SETUP_NONCE');
  if (!nonce || parameters.platform_nonce !== nonce) throw new Error('연결 화면이 만료되었습니다. 다시 열어주세요.');
  var url = String(parameters.platform_url || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-zA-Z0-9.-]+(?::443)?$/.test(url)) throw new Error('HTTPS 서버 주소를 입력하세요.');
  var response = UrlFetchApp.fetch(url + '/api/v1/collectors/pair', {
    method: 'post', contentType: 'application/json', followRedirects: false, muteHttpExceptions: true,
    payload: JSON.stringify({ code: String(parameters.pairing_code || '').trim() })
  });
  if (response.getResponseCode() !== 200) throw new Error('Healine 연결 실패. 서버 주소와 코드 만료 여부를 확인하세요.');
  var result = JSON.parse(response.getContentText());
  if (!result.key || !result.connection_id) throw new Error('Healine 연결 응답을 확인할 수 없습니다.');
  props.setProperty(HEALINE.propertyKeys.platformUrl, url);
  props.setProperty(HEALINE.propertyKeys.platformKey, result.key);
  props.setProperty(HEALINE.propertyKeys.platformBackfillDate, addIsoDays_(formatIsoDate_(new Date()), -HEALINE.baselineDays));
  props.deleteProperty(HEALINE.propertyKeys.baseline);
  props.deleteProperty(HEALINE.propertyKeys.baselineAttemptDate);
  var message = 'Healine에 연결했습니다.';
  try { runHealine(); message += ' 첫 수집과 캘린더 갱신도 완료했습니다.'; }
  catch (error) { message += ' 첫 수집은 다음 실행에서 다시 시도합니다: ' + error.message; }
  return HtmlService.createHtmlOutput('<h2>Healine 플랫폼 연결</h2><p>' + escapeHtml_(message) + '</p>');
}
