// Local stand-in for Google Apps Script so the app can be tested before deploying.
// Runs apps-script/Code.gs unchanged against an in-memory spreadsheet that copies the Sheets
// behaviours the code has to survive: auto-parsing of "+971...", "18:30", "=..." in cells
// without a text format, checkbox cells counting as content, the 100 KB cache value limit,
// and Apps Script returning null when a server function returns a Date.
//
//   node dev/server.mjs            -> http://localhost:8793
//   POST /__dev/seed  sample data     POST /__dev/reset  empty sheet     GET /__dev/sheet  raw tabs
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = Number(process.env.PORT || 8793);
const CODE = join(root, 'apps-script', 'Code.gs');
const INDEX = join(root, 'apps-script', 'Index.html');
const STATE = join(here, 'sheet.local.json');

/* ---------- fake spreadsheet ---------- */

const sheetEpoch = new Date(1899, 11, 30);
function coerce(v, fmt) {
  if (v == null) return '';
  if (v instanceof Date || typeof v === 'number' || typeof v === 'boolean') return v;
  const s = String(v);
  if (fmt === '@' || s === '') return s;
  if (/^[+-]?\d+(\.\d+)?$/.test(s.trim())) return Number(s);
  if (s[0] === '=') return '#ERROR!';
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return new Date(1899, 11, 30, Number(m[1]), Number(m[2]));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
  return s;
}

class FakeSheet {
  constructor(name) { this.name = name; this.cells = []; this.fmts = []; this.maxRows = 1000; this.frozen = 0; }
  getName() { return this.name; }
  getMaxRows() { return this.maxRows; }
  getLastRow() {
    for (let r = this.cells.length - 1; r >= 0; r--) {
      if ((this.cells[r] || []).some((v) => v !== '' && v != null)) return r + 1;
    }
    return 0;
  }
  getRange(a, b, c, d) {
    if (typeof a === 'string') throw new Error('A1 ranges are not mocked');
    return new FakeRange(this, a, b, c || 1, d || 1);
  }
  setFrozenRows(n) { this.frozen = n; return this; }
  setColumnWidth() { return this; }
  deleteRow(r) { this.cells.splice(r - 1, 1); this.fmts.splice(r - 1, 1); return this; }
  get(r, c) { const row = this.cells[r - 1]; const v = row ? row[c - 1] : undefined; return v == null ? '' : v; }
  set(r, c, v) {
    if (r > this.maxRows) this.maxRows = r;
    (this.cells[r - 1] || (this.cells[r - 1] = []))[c - 1] = coerce(v, this.fmt(r, c));
  }
  fmt(r, c) { const row = this.fmts[r - 1]; return row ? row[c - 1] : undefined; }
  setFmt(r, c, f) { (this.fmts[r - 1] || (this.fmts[r - 1] = []))[c - 1] = f; }
}

class FakeRange {
  constructor(sh, row, col, nr, nc) {
    if (row < 1 || col < 1 || nr < 1 || nc < 1) throw new Error(`Bad range ${row},${col},${nr},${nc}`);
    Object.assign(this, { sh, row, col, nr, nc });
  }
  each(fn) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.row + i, this.col + j, i, j); }
  getValues() {
    const out = Array.from({ length: this.nr }, () => new Array(this.nc));
    this.each((r, c, i, j) => { const v = this.sh.get(r, c); out[i][j] = v instanceof Date ? new Date(v) : v; });
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) {
    if (vals.length !== this.nr || vals.some((row) => row.length !== this.nc)) {
      throw new Error(`The data has ${vals.length}x${vals[0] && vals[0].length} but the range has ${this.nr}x${this.nc}`);
    }
    this.each((r, c, i, j) => this.sh.set(r, c, vals[i][j]));
    return this;
  }
  setValue(v) { this.each((r, c) => this.sh.set(r, c, v)); return this; }
  setNumberFormat(f) { this.each((r, c) => this.sh.setFmt(r, c, f)); return this; }
  setNumberFormats(f2) {
    if (f2.length !== this.nr || f2.some((row) => row.length !== this.nc)) throw new Error('Number format grid does not match the range');
    this.each((r, c, i, j) => this.sh.setFmt(r, c, f2[i][j]));
    return this;
  }
  insertCheckboxes() { this.each((r, c) => this.sh.set(r, c, false)); return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setFontColor() { return this; }
}

const book = { sheets: [] };
function freshBook() { book.sheets = [new FakeSheet('Sheet1')]; }

function saveState() {
  const plain = book.sheets.map((s) => ({
    name: s.name, frozen: s.frozen, fmts: s.fmts,
    cells: s.cells.map((row) => (row || []).map((v) => (v instanceof Date ? { $date: v.getTime() } : v)))
  }));
  writeFileSync(STATE, JSON.stringify(plain));
}
function loadState() {
  if (!existsSync(STATE)) return freshBook();
  const plain = JSON.parse(readFileSync(STATE, 'utf8'));
  book.sheets = plain.map((p) => {
    const s = new FakeSheet(p.name);
    s.frozen = p.frozen;
    s.fmts = p.fmts || [];
    s.cells = p.cells.map((row) => (row || []).map((v) => (v && typeof v === 'object' && '$date' in v ? new Date(v.$date) : v)));
    return s;
  });
}

const spreadsheet = {
  getSheetByName: (n) => book.sheets.find((s) => s.name === n) || null,
  insertSheet: (n) => { const s = new FakeSheet(n); book.sheets.push(s); return s; },
  getSheets: () => book.sheets.slice(),
  deleteSheet: (s) => { book.sheets = book.sheets.filter((x) => x !== s); },
  setSpreadsheetTimeZone: () => {},
  getUrl: () => 'https://docs.google.com/spreadsheets/d/LOCAL-DEV-SHEET/edit',
  getId: () => 'LOCAL-DEV-SHEET'
};

/* ---------- fake Apps Script services ---------- */

const cacheStore = new Map();
const cache = {
  get(k) { const e = cacheStore.get(k); if (!e || e.exp < Date.now()) { cacheStore.delete(k); return null; } return e.v; },
  put(k, v, ttl = 600) {
    if (String(v).length > 100000) throw new Error('Argument too large: value');
    cacheStore.set(k, { v: String(v), exp: Date.now() + Math.min(ttl, 21600) * 1000 });
  },
  getAll(keys) { const o = {}; keys.forEach((k) => { const v = cache.get(k); if (v != null) o[k] = v; }); return o; },
  putAll(obj, ttl) { Object.keys(obj).forEach((k) => cache.put(k, obj[k], ttl)); },
  remove(k) { cacheStore.delete(k); },
  removeAll(keys) { keys.forEach((k) => cacheStore.delete(k)); }
};

const services = {
  SpreadsheetApp: {
    getActiveSpreadsheet: () => spreadsheet,
    flush: () => {},
    getUi: () => { throw new Error('Cannot call SpreadsheetApp.getUi() from this context.'); }
  },
  CacheService: { getScriptCache: () => cache },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {}, hasLock: () => true }) },
  HtmlService: {
    createHtmlOutputFromFile: () => {
      const out = { setTitle: () => out, addMetaTag: () => out, setXFrameOptionsMode: () => out, setFaviconUrl: () => out };
      return out;
    },
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' }
  },
  ScriptApp: { getService: () => ({ getUrl: () => `http://localhost:${PORT}/` }) },
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (s) => { const out = { mime: 'text/plain', setMimeType: (m) => { out.mime = m; return out; }, getContent: () => s }; return out; }
  },
  Logger: { log: (...a) => console.log('[Logger]', ...a) }
};

let script = null;
let scriptMtime = 0;
function gas() {
  const m = statSync(CODE).mtimeMs;
  if (!script || m !== scriptMtime) {
    const names = Object.keys(services);
    const factory = new Function(...names, readFileSync(CODE, 'utf8') + '\n;return { api, doGet, doPost, setup };');
    script = factory(...names.map((n) => services[n]));
    scriptMtime = m;
    console.log('loaded Code.gs');
  }
  return script;
}

function hasDate(v) {
  if (v instanceof Date) return true;
  if (v && typeof v === 'object') return Object.values(v).some(hasDate);
  return false;
}

/* ---------- sample data (local testing only, never deployed) ---------- */

function setting(key) {
  const sh = spreadsheet.getSheetByName('Settings');
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  return String(rows.find((r) => r[0] === key)[1]);
}
const adminPin = () => setting('admin_pin');

function seed() {
  freshBook();
  cacheStore.clear();
  const g = gas();
  g.setup();
  const admin = { id: 'admin', pin: adminPin() };
  const must = (res) => { if (!res.ok) throw new Error(res.error); return res.data; };
  const inDays = new Date(Date.now() + 4 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  must(g.api('saveEvent', { auth: admin, event: { name: 'DEEN Open House', tagline: 'Sample event for local testing', daily: true, date: inDays, start: '09:00', end: '22:00', venue: 'Sample venue, Business Bay', open: true } }));
  const agents = [['Sample Agent A', '4821'], ['Sample Agent B', 'DP07'], ['Sample Agent C', '1597'], ['Sample Agent D', '8642'], ['Sample Agent E', '3075']];
  agents.forEach(([name, code]) => must(g.api('saveAgent', { auth: admin, agent: { name, code } })));
  const ids = must(g.api('sync', { auth: admin })).mine.agents.map((a) => ({ id: a.name, pin: a.code }));
  const statuses = ['Confirmed', 'Confirmed', 'Confirmed', 'Maybe', 'Awaiting', 'Confirmed', 'Declined', 'Confirmed'];
  const interests = ['2 BR', 'Investment', '', 'Villa / Townhouse', 'Studio / 1 BR', '3 BR+', ''];
  for (let i = 0; i < 34; i++) {
    const who = ids[[0, 0, 0, 1, 1, 1, 2, 2, 3, 4][i % 10]];
    must(g.api('saveRsvp', { auth: who, rsvp: {
      name: 'Test Guest ' + String(i + 1).padStart(2, '0'), mobile: '05' + String(52000000 + i * 7919).slice(0, 8),
      party: [1, 2, 2, 3, 1, 4, 2][i % 7], status: statuses[i % statuses.length], arrival: ['18:00', '18:30', '19:00', ''][i % 4],
      interest: interests[i % interests.length], budget: ['AED 1M - 2M', '', 'AED 2M - 5M'][i % 3], notes: i % 5 === 0 ? 'Sample note: prefers a high floor' : ''
    } }));
  }
  saveState();
  return { adminPin: admin.pin, boardKey: setting('board_key'), agents: agents.map(([name, code]) => ({ name, code })) };
}

/* ---------- http ---------- */

const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
const readBody = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => ok(s)); });

loadState();
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      gas().doGet();
      saveState();
      const html = readFileSync(INDEX, 'utf8').replace('<head>', '<head><script src="/__dev/gas-shim.js"></script>');
      return send(res, 200, 'text/html; charset=utf-8', html);
    }
    // The GitHub Pages copy of the page, talking to /__exec like it talks to the real web app
    if (req.method === 'GET' && url.pathname === '/hosted') return send(res, 200, 'text/html; charset=utf-8', readFileSync(join(here, 'site-local.html')));
    if (req.method === 'POST' && url.pathname === '/__exec') {
      const body = await readBody(req);
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 350));
      const out = gas().doPost({ postData: { contents: body, type: 'text/plain' } });
      saveState();
      res.writeHead(200, { 'Content-Type': out.mime, 'Cache-Control': 'no-store' });
      return res.end(out.getContent());
    }
    if (req.method === 'GET' && url.pathname === '/__dev/gas-shim.js') return send(res, 200, 'text/javascript', readFileSync(join(here, 'gas-shim.js')));
    if (req.method === 'GET' && url.pathname === '/__dev/sheet') {
      const dump = Object.fromEntries(book.sheets.map((s) => [s.name, s.cells.slice(0, s.getLastRow()).map((r) => (r || []).map((v) => (v instanceof Date ? v.toISOString() : v)))]));
      return send(res, 200, 'application/json', JSON.stringify(dump, null, 1));
    }
    if (req.method === 'POST' && url.pathname === '/__dev/seed') return send(res, 200, 'application/json', JSON.stringify(seed()));
    if (req.method === 'POST' && url.pathname === '/__dev/reset') { freshBook(); cacheStore.clear(); saveState(); return send(res, 200, 'application/json', '{"ok":true}'); }
    if (req.method === 'POST' && url.pathname.startsWith('/__gas/')) {
      const fn = decodeURIComponent(url.pathname.slice(7));
      const args = JSON.parse((await readBody(req)) || '[]');
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 350));
      const g = gas();
      if (!/^[A-Za-z]\w*$/.test(fn) || fn.endsWith('_') || typeof g[fn] !== 'function') return send(res, 200, 'application/json', JSON.stringify({ error: `Script function not found: ${fn}` }));
      let value;
      try { value = g[fn](...args); } catch (e) { return send(res, 200, 'application/json', JSON.stringify({ error: e.message })); }
      saveState();
      if (hasDate(value)) {
        console.warn(`WARNING ${fn}(${args[0]}) returned a Date; real Apps Script would deliver null`);
        value = null;
      }
      return send(res, 200, 'application/json', JSON.stringify({ value }));
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    console.error(e);
    send(res, 500, 'text/plain', String(e && e.stack || e));
  }
}).listen(PORT, () => console.log(`Open House RSVP dev server on http://localhost:${PORT}`));
