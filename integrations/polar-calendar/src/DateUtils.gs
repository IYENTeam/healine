function previousCompleteWindow_(now) {
  var durationMs = HEALINE.windowMinutes * 60 * 1000;
  var endMs = Math.floor(now.getTime() / durationMs) * durationMs;
  return {
    start: new Date(endMs - durationMs),
    end: new Date(endMs)
  };
}

function recentCompleteWindows_(now, lookbackMinutes) {
  var latest = previousCompleteWindow_(now);
  var durationMs = HEALINE.windowMinutes * 60 * 1000;
  var requestedMinutes = Number(lookbackMinutes || HEALINE.windowMinutes);
  var windowCount = Math.max(1, Math.ceil(requestedMinutes / HEALINE.windowMinutes));
  var windows = [];

  for (var index = windowCount - 1; index >= 0; index -= 1) {
    var endMs = latest.end.getTime() - index * durationMs;
    windows.push({
      start: new Date(endMs - durationMs),
      end: new Date(endMs)
    });
  }
  return windows;
}

function formatIsoDate_(date) {
  return Utilities.formatDate(date, HEALINE.timezone, 'yyyy-MM-dd');
}

function addIsoDays_(isoDate, dayCount) {
  var start = Date.parse(isoDate + 'T12:00:00' + HEALINE.timezoneOffset);
  return formatIsoDate_(new Date(start + dayCount * 24 * 60 * 60 * 1000));
}

function localDayStartMs_(isoDate) {
  return Date.parse(isoDate + 'T00:00:00' + HEALINE.timezoneOffset);
}

function localSampleTimeMs_(isoDate, sampleTime) {
  if (!sampleTime) return localDayStartMs_(isoDate);
  if (/^\d{2}:\d{2}/.test(sampleTime)) {
    return Date.parse(isoDate + 'T' + sampleTime + HEALINE.timezoneOffset);
  }
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(sampleTime)) {
    return Date.parse(sampleTime);
  }
  return Date.parse(sampleTime + HEALINE.timezoneOffset);
}

function seoulHour_(timestampMs) {
  return new Date(timestampMs + 9 * 60 * 60 * 1000).getUTCHours();
}

function formatWindowKey_(window) {
  return Utilities.formatDate(window.start, HEALINE.timezone, 'yyyyMMdd-HHmm');
}

function formatDateTime_(date) {
  return Utilities.formatDate(date, HEALINE.timezone, 'yyyy-MM-dd HH:mm:ss');
}

function dateKeyPure_(timestampMs) {
  return new Date(timestampMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isoDatesBetween_(from, to) {
  var dates = [];
  for (var date = from; date < to; date = addIsoDays_(date, 1)) dates.push(date);
  return dates;
}
