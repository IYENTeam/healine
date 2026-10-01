const assert = require('node:assert/strict');
const test = require('node:test');
const { load } = require('./helpers');

function environment() {
  const e=load();
  const c=e.context;
  let locked=false;
  c.assertHealineConfigured_=()=>({clientId:'test-client',clientSecret:'test-secret',redirectUri:'https://example.com/callback'});
  c.Utilities.base64Encode=value=>Buffer.from(value).toString('base64');
  c.LockService={getScriptLock:()=>({
    tryLock(){assert.equal(locked,false);locked=true;return true;},
    releaseLock(){assert.equal(locked,true);locked=false;}
  })};
  e.isLocked=()=>locked;
  e.properties.setProperties({POLAR_ACCESS_TOKEN:'old-access',POLAR_REFRESH_TOKEN:'old-refresh',POLAR_EXPIRES_AT:'1'});
  c.UrlFetchApp={fetch(){assert.fail('unexpected network request');}};
  return e;
}
const response=(status,body)=>({getResponseCode:()=>status,getContentText:()=>JSON.stringify(body)});

test('refresh rereads credentials after acquiring the lock and reuses a concurrent refresh',()=>{
  const {context:c,properties}=environment();
  let released=false;
  c.LockService={getScriptLock:()=>({
    tryLock(){c.savePolarToken_({access_token:'concurrent',refresh_token:'rotated',expires_in:3600},'refresh_token');return true;},
    releaseLock(){released=true;}
  })};
  assert.equal(c.getValidPolarAccessToken_(),'concurrent');
  assert.equal(properties.getProperty('POLAR_REFRESH_TOKEN'),'rotated');
  assert.equal(released,true);
});

test('rotated refresh credentials persist before unlocking; omitted replacements retain the current token',()=>{
  const {context:c,properties,isLocked}=environment();
  let calls=0;
  c.UrlFetchApp.fetch=(_url,options)=>{
    assert.equal(isLocked(),true);
    assert.equal(options.payload.grant_type,'refresh_token');
    assert.equal(options.payload.refresh_token,calls===0?'old-refresh':'next-refresh');
    calls++;
    return response(200,calls===1?{access_token:'next-access',refresh_token:'next-refresh',expires_in:3600}:{access_token:'latest-access',expires_in:3600});
  };
  assert.equal(c.getValidPolarAccessToken_(),'next-access');
  assert.equal(c.getValidPolarAccessToken_(),'next-access');
  assert.equal(calls,1);
  c.refreshPolarToken_(null,true);
  assert.equal(properties.getProperty('POLAR_REFRESH_TOKEN'),'next-refresh');
  assert.equal(c.getPolarTokenLifecycle_().refreshCount,2);
  assert.equal(c.getPolarTokenLifecycle_().refreshTokenReplaced,false);
  assert.equal(isLocked(),false);
  assert.doesNotMatch(JSON.stringify(c.getPolarTokenLifecycle_()),/next-access|next-refresh|latest-access/);
});

test('actual one-hour expiry renews five minutes early instead of assuming the documented twelve hours',()=>{
  const {context:c}=environment();
  let now=Date.parse('2026-10-01T00:00:00Z'),calls=0;
  c.Date=class extends Date {
    constructor(...args){super(...(args.length?args:[now]));}
    static now(){return now;}
  };
  c.UrlFetchApp.fetch=()=>{calls++;return response(200,{access_token:'access-'+calls,expires_in:3599});};
  assert.equal(c.getValidPolarAccessToken_(),'access-1');
  now+=54*60000;
  assert.equal(c.getValidPolarAccessToken_(),'access-1');
  now+=60000;
  assert.equal(c.getValidPolarAccessToken_(),'access-2');
  assert.equal(calls,2);
});

test('a late 401 retries the new authorization without deleting it or refreshing again',()=>{
  const {context:c,properties}=environment();
  c.savePolarToken_({access_token:'request-access',refresh_token:'request-refresh',expires_in:3600});
  const used=[];
  c.fetchPolarWithToken_=(_url,token)=>{
    used.push(token);
    if(used.length===1){
      c.savePolarToken_({access_token:'callback-access',refresh_token:'callback-refresh',expires_in:3600},'authorization_code');
      return response(401,{});
    }
    return response(200,{data:{ok:true}});
  };
  assert.equal(c.polarGet_('/activity/list').data.ok,true);
  assert.deepEqual(used,['request-access','callback-access']);
  assert.equal(properties.getProperty('POLAR_REFRESH_TOKEN'),'callback-refresh');
});

test('the same rejected access token refreshes once and a persistent 401 does not loop',()=>{
  const {context:c}=environment();
  c.savePolarToken_({access_token:'rejected',refresh_token:'refresh',expires_in:3600});
  let refreshes=0,reads=0;
  c.UrlFetchApp.fetch=()=>{refreshes++;return response(200,{access_token:'replacement',expires_in:3600});};
  c.fetchPolarWithToken_=()=>{reads++;return response(401,{error:'unauthorized'});};
  assert.throws(()=>c.polarGet_('/activity/list'),/401/);
  assert.equal(refreshes,1);assert.equal(reads,2);
});

test('invalid grant records only protocol metadata, blocks refresh retries, and survives unrelated errors',()=>{
  const {context:c,properties}=environment();
  let calls=0;
  c.UrlFetchApp.fetch=()=>{calls++;return response(400,{error:'invalid_grant',error_description:'denied old-refresh secret-value'});};
  let failure;
  try { c.getValidPolarAccessToken_(); } catch(error){failure=error;}
  assert.equal(failure.oauthError,'invalid_grant');
  assert.equal(failure.httpStatus,400);
  assert.doesNotMatch(failure.message,/old-refresh|secret-value/);
  c.recordHealineFailure_(Error('temporary platform outage'));
  assert.equal(c.isPolarReconnectRequired_(),true);
  assert.throws(()=>c.getValidPolarAccessToken_(),/POLAR_RECONNECT_REQUIRED/);
  assert.equal(calls,1);
  assert.equal(properties.getProperty('POLAR_REFRESH_TOKEN'),'old-refresh');
  assert.doesNotMatch(JSON.stringify(c.getPolarTokenLifecycle_()),/old-refresh|secret-value/);
});

test('a delayed old-generation failure cannot mark a new callback as disconnected',()=>{
  const {context:c,properties}=environment();
  c.UrlFetchApp.fetch=()=>response(400,{error:'invalid_grant'});
  let failure;
  try { c.refreshPolarToken_(); } catch(error){failure=error;}
  c.savePolarToken_({access_token:'reauthorized',refresh_token:'new-refresh',expires_in:3600},'authorization_code');
  assert.equal(c.recordHealineFailure_(failure).code,'sync_superseded');
  assert.equal(properties.getProperty('HEALINE_LAST_ERROR'),null);
  assert.equal(c.isPolarReconnectRequired_(),false);
});

test('temporary token service failures preserve credentials and allow later refresh',()=>{
  const {context:c,properties,isLocked}=environment();
  c.UrlFetchApp.fetch=()=>response(503,{error:'temporarily_unavailable'});
  assert.throws(()=>c.refreshPolarToken_(),/503/);
  assert.equal(isLocked(),false);
  assert.equal(c.isPolarReconnectRequired_(),false);
  assert.equal(properties.getProperty('POLAR_REFRESH_TOKEN'),'old-refresh');
  c.UrlFetchApp.fetch=()=>response(200,{access_token:'recovered',expires_in:3600});
  assert.equal(c.refreshPolarToken_(),'recovered');
  assert.equal(c.getPolarTokenLifecycle_().lastFailure.oauthError,'temporarily_unavailable');
});

test('callback exchange and persistence use the token lock and refuse incomplete grants',()=>{
  const {context:c,properties,isLocked}=environment();
  c.UrlFetchApp.fetch=(_url,options)=>{
    assert.equal(isLocked(),true);assert.equal(options.payload.grant_type,'authorization_code');
    return response(200,{access_token:'incomplete',expires_in:3600});
  };
  assert.throws(()=>c.exchangeAuthorizationCode_('test-code'),/갱신 토큰/);
  assert.equal(properties.getProperty('POLAR_ACCESS_TOKEN'),'old-access');
  c.UrlFetchApp.fetch=()=>response(200,{access_token:'complete',refresh_token:'complete-refresh',expires_in:3600,scope:'sleep:read'});
  c.exchangeAuthorizationCode_('test-code');
  assert.equal(properties.getProperty('POLAR_ACCESS_TOKEN'),'complete');
  assert.equal(properties.getProperty('HEALINE_SLEEP_ACCESS'),'granted');
  assert.equal(c.getPolarTokenLifecycle_().lastGrantType,'authorization_code');
  assert.equal(isLocked(),false);
});

test('lock timeout, invalid lifetime and malformed token JSON never destroy a working token',()=>{
  const {context:c,properties}=environment();
  assert.throws(()=>c.savePolarToken_({access_token:'bad',expires_in:0}),/유효 시간/);
  assert.equal(properties.getProperty('POLAR_ACCESS_TOKEN'),'old-access');
  c.UrlFetchApp.fetch=()=>({getResponseCode:()=>200,getContentText:()=>'{"access_token":"secret-value" BROKEN'});
  assert.throws(()=>c.refreshPolarToken_(),error=>/JSON/.test(error.message)&&!error.message.includes('secret-value'));
  c.LockService={getScriptLock:()=>({tryLock:()=>false,releaseLock(){assert.fail();}})};
  assert.throws(()=>c.exchangeAuthorizationCode_('test-code'),/갱신 중/);
  assert.equal(properties.getProperty('POLAR_REFRESH_TOKEN'),'old-refresh');
});
