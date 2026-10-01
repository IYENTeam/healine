const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load(extra = {}) {
  const values = new Map();
  const properties = {
    getProperty: k => values.get(k) ?? null,
    setProperty(k, v) { values.set(k, v); },
    deleteProperty(k) { values.delete(k); },
    setProperties(obj) { Object.entries(obj).forEach(([k, v]) => values.set(k, v)); }
  };
  const context = vm.createContext({
    console, Date, Math, Number, Object, Array, String, JSON,
    PropertiesService: { getUserProperties: () => properties },
    Utilities: { formatDate(date, zone, format) {
      const s = new Date(date.getTime() + 9 * 3600000).toISOString();
      if (format === 'yyyy-MM-dd') return s.slice(0, 10);
      if (format === 'HH:mm') return s.slice(11, 16);
      return s.slice(0, 19).replace('T', ' ');
    } }, ...extra
  });
  for (const file of ['Config', 'DateUtils', 'StressEngine', 'PolarClient', 'Baseline', 'CalendarSink', 'Main', 'PolarAuth']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', file + '.gs'), 'utf8'), context);
  }
  return { context, properties };
}
module.exports = { load };
