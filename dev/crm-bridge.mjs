// Server-to-server bridge. The page keeps calling POST /__exec { action, payload }.
// This process reads Open House events and RSVPs from the DEEN CRM and returns
// them in the shape the page already draws. It does not store guests.
//
//   CRM_API_BASE_URL=http://127.0.0.1:3001
//   RSVP_DASHBOARD_API_KEY=<same key as the CRM backend>
//   DASHBOARD_ADMIN_PIN=482913
//   node dev/crm-bridge.mjs
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

loadEnv(join(root, '.env'));

const STATUS_LABEL = { confirmed: 'Confirmed', maybe: 'Maybe', awaiting: 'Awaiting', declined: 'Declined' };
const READ_ONLY = 'RSVPs are managed in DEEN CRM. Change the guest there and this board refreshes on the next update.';

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const i = trimmed.indexOf('=');
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 8);
}

function ms(value) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function ymd(value) {
  if (!value) return '';
  const text = typeof value === 'string' ? value : new Date(value).toISOString();
  return text.slice(0, 10);
}

function maskName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || 'Guest';
  return parts[0] + ' ' + parts[1][0] + '.';
}

export function toPageEvent(event) {
  if (!event) {
    return { name: 'DEEN Open House', tagline: '', date: '', daily: false, start: '09:00', end: '22:00', venue: '', open: true, offset: '+04:00' };
  }
  return {
    name: event.eventName || 'DEEN Open House',
    tagline: '',
    date: ymd(event.eventDate),
    daily: false,
    start: event.startTime || '09:00',
    end: event.endTime || '22:00',
    venue: [event.venueName, event.location].filter(Boolean).join(', '),
    open: event.status !== 'cancelled' && event.status !== 'completed',
    offset: '+04:00',
  };
}

export function toPageRsvp(row) {
  return {
    id: row.id,
    created: ms(row.createdAt),
    updated: ms(row.updatedAt),
    agent: row.createdByName || '',
    name: row.guestName,
    mobile: row.mobile || '',
    party: Number(row.party) || 1,
    status: STATUS_LABEL[row.status] || 'Awaiting',
    arrival: row.expectedArrival || '',
    interest: row.interestedInLabel || '',
    budget: row.budgetLabel || '',
    notes: row.notes || '',
    checkedIn: 0,
    checkedBy: '',
    eventId: row.event?.id || '',
    eventName: row.event?.eventName || '',
  };
}

export function toTotals(stats) {
  const records = stats?.records || {};
  const attendees = stats?.attendees || {};
  const today = stats?.today || {};
  return {
    parties: records.total || 0,
    confirmed: attendees.confirmed || 0,
    confirmedParties: records.confirmed || 0,
    maybe: attendees.maybe || 0,
    awaiting: records.awaiting || 0,
    declined: records.declined || 0,
    arrived: 0,
    arrivedParties: 0,
    todayNew: today.newRsvps || 0,
    todayConfirmed: today.confirmedAttendees || 0,
    todayArrived: 0,
  };
}

function crmConfig() {
  const base = (process.env.CRM_API_BASE_URL || '').trim().replace(/\/$/, '');
  const key = (process.env.RSVP_DASHBOARD_API_KEY || '').trim();
  if (!base) throw Object.assign(new Error('Set CRM_API_BASE_URL to the DEEN CRM backend.'), { status: 500 });
  if (key.length < 16) throw Object.assign(new Error('Set RSVP_DASHBOARD_API_KEY on the dashboard server. It must match the CRM.'), { status: 500 });
  return { base, key };
}

async function crmGet(path) {
  const { base, key } = crmConfig();
  let res;
  try {
    res = await fetch(base + '/api/open-house/dashboard' + path, {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
    });
  } catch (err) {
    throw Object.assign(new Error('Could not reach the CRM. ' + (err.message || '')), { status: 502 });
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const message = res.status === 401
      ? 'The CRM rejected the dashboard key.'
      : res.status === 503
        ? 'The CRM dashboard API is not configured.'
        : (body && body.error) || 'CRM request failed (' + res.status + ').';
    throw Object.assign(new Error(message), { status: res.status });
  }
  return body || {};
}

async function crmList(path) {
  const pageSize = 100;
  const rows = [];
  for (let page = 1; page <= 100; page++) {
    const join = path.includes('?') ? '&' : '?';
    const body = await crmGet(path + join + 'page=' + page + '&pageSize=' + pageSize);
    const chunk = Array.isArray(body.data) ? body.data : [];
    rows.push(...chunk);
    const total = body.meta?.total ?? body.total ?? rows.length;
    if (!chunk.length || rows.length >= total) break;
  }
  return rows;
}

async function loadCrm() {
  const [events, stats, rsvps] = await Promise.all([
    crmList('/events'),
    crmGet('/stats'),
    crmList('/rsvps'),
  ]);
  return { events, stats: stats.data || stats, rsvps };
}

function boardFrom(snapshot) {
  const stats = snapshot.stats;
  const rsvps = snapshot.rsvps.map(toPageRsvp).sort((a, b) => b.created - a.created);
  const agents = (stats.byCreator || []).map((creator) => ({
    id: creator.createdByName,
    name: creator.createdByName,
    active: true,
    confirmed: creator.expectedAttendees,
    parties: creator.records.total,
    arrived: 0,
    today: creator.todayNew,
    todayConfirmed: 0,
  }));
  const feed = rsvps.slice(0, 14).map((row) => ({
    t: row.created,
    who: row.agent || 'CRM',
    action: 'added',
    guest: maskName(row.name),
    party: row.party,
    status: row.status,
  }));
  const totals = toTotals(stats);
  const arrivals = stats.byArrival || [];
  return { totals, agents, feed, arrivals, v: hash({ totals, agents, feed, arrivals }) };
}

function mineFrom(snapshot, event) {
  const rsvps = snapshot.rsvps.map(toPageRsvp).sort((a, b) => b.created - a.created);
  const names = [];
  for (const row of rsvps) {
    if (row.agent && !names.some((name) => name.toLowerCase() === row.agent.toLowerCase())) names.push(row.agent);
  }
  names.sort((a, b) => a.localeCompare(b));
  const mine = {
    who: { id: 'admin', name: 'CEO', role: 'admin' },
    open: event.open,
    rsvps,
    agents: names.map((name) => ({ name, code: '' })),
    settings: event,
    boardKey: process.env.DASHBOARD_BOARD_KEY || '',
    sheetUrl: '',
    appUrl: '',
    v: hash(rsvps.map((row) => [row.id, row.updated, row.status, row.party, row.agent])),
  };
  return mine;
}

function adminOk(auth) {
  const pin = (process.env.DASHBOARD_ADMIN_PIN || '').trim();
  if (!pin || !auth) return false;
  return String(auth.id || '').trim().toLowerCase() === 'admin' && String(auth.pin || '') === pin;
}

function boardAllowed(payload) {
  if (adminOk(payload.auth)) return true;
  const key = (process.env.DASHBOARD_BOARD_KEY || '').trim();
  if (!key) return true;
  return String(payload.boardKey || '') === key;
}

export async function handleAction(body) {
  const action = body && body.action;
  const payload = (body && body.payload) || {};
  if (action === 'saveRsvp' || action === 'deleteRsvp' || action === 'checkIn' || action === 'saveAgent' || action === 'deleteAgent' || action === 'saveEvent' || action === 'savePhoto') {
    return { ok: false, error: READ_ONLY };
  }
  if (action !== 'sync' && action !== 'login' && action !== 'photos') {
    return { ok: false, error: 'Unknown action.' };
  }
  if (action === 'photos') return { ok: true, data: { v: '0', map: {} } };

  if (action === 'login' && !adminOk(payload.auth)) {
    const pin = (process.env.DASHBOARD_ADMIN_PIN || '').trim();
    if (!pin) return { ok: false, error: 'Set DASHBOARD_ADMIN_PIN on the dashboard server before signing in.' };
    if (String(payload.auth?.id || '').trim().toLowerCase() !== 'admin') {
      return { ok: false, error: 'Sign in as the CEO. Staff see only their own RSVPs inside DEEN CRM.' };
    }
    return { ok: false, error: 'Wrong PIN.' };
  }

  const snapshot = await loadCrm();
  const headerEvent = toPageEvent((snapshot.stats.byEvent && snapshot.stats.byEvent[0] && snapshot.stats.byEvent[0].event) || snapshot.events[0]);
  const names = [];
  for (const row of snapshot.rsvps) {
    const name = row.createdByName || '';
    if (name && !names.includes(name)) names.push(name);
  }
  names.sort((a, b) => a.localeCompare(b));

  const data = { event: headerEvent, agentNames: names, now: Date.now() };
  const seeBoard = action === 'login' || boardAllowed(payload);
  const sentBadKey = payload.boardKey && process.env.DASHBOARD_BOARD_KEY && payload.boardKey !== process.env.DASHBOARD_BOARD_KEY;
  if (sentBadKey && !adminOk(payload.auth)) data.boardKeyBad = true;

  if (seeBoard && !data.boardKeyBad) {
    const board = boardFrom(snapshot);
    data.board = payload.boardV && payload.boardV === board.v ? { v: board.v, same: true } : board;
    data.photosV = '0';
  }
  if (action === 'login' || adminOk(payload.auth)) {
    const mine = mineFrom(snapshot, headerEvent);
    data.mine = payload.mineV && payload.mineV === mine.v ? { v: mine.v, same: true } : mine;
    data.photosV = '0';
  }
  return { ok: true, data };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(Object.assign(new Error('Unknown action.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function listenPort(port) {
  if (port !== undefined) return port;
  const raw = process.env.PORT;
  if (raw === undefined || String(raw).trim() === '') return 8794;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error('PORT must be an integer from 0 to 65535.');
  }
  return parsed;
}

function sameFile(moduleUrl, filePath) {
  if (!filePath) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(filePath)).href;
  } catch {
    return false;
  }
}

// `node dev/crm-bridge.mjs` sets argv[1] to this file.
// PM2 fork mode does not: it runs ProcessContainerFork.js and import()s this
// file, leaving the real script path in pm_exec_path. The argv check alone
// skips listen(), the process exits, and PM2 ends up stopped with nothing on 8794.
export function shouldStartServer(moduleUrl = import.meta.url, env = process.env, argv = process.argv) {
  if (sameFile(moduleUrl, env.pm_exec_path)) return true;
  return argv.slice(1).some((arg) => sameFile(moduleUrl, arg));
}

export function start(port) {
  port = listenPort(port);
  const pagePath = join(root, 'dev', 'site-local.html');
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const isPage = url.pathname === '/' || url.pathname === '/index.html';
      if ((req.method === 'GET' || req.method === 'HEAD') && isPage) {
        if (!existsSync(pagePath)) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(req.method === 'HEAD' ? '' : 'Run node build.mjs so dev/site-local.html exists.');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? '' : readFileSync(pagePath));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/__exec') {
        const body = await readBody(req);
        const answer = await handleAction(body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(answer));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    } catch (err) {
      const message = err && err.message ? err.message : 'Server error.';
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
  });
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(server);
    });
  });
}

if (shouldStartServer()) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error('RSVP dashboard bridge requires Node.js 18 or newer. This process is ' + process.version + '.');
    process.exit(1);
  }
  let server;
  try {
    server = await start();
  } catch (err) {
    console.error('RSVP dashboard bridge failed to listen on 127.0.0.1:' + (process.env.PORT || 8794));
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
  const address = server.address();
  console.log('RSVP dashboard bridge  http://127.0.0.1:' + address.port);
  console.log('Node                   ' + process.version);
  console.log('CRM                    ' + (process.env.CRM_API_BASE_URL || '(CRM_API_BASE_URL is not set)'));
} else if (process.env.pm_id !== undefined) {
  console.error('RSVP dashboard bridge was loaded by PM2 but did not recognize its script path.');
  console.error('pm_exec_path=' + (process.env.pm_exec_path || ''));
  process.exit(1);
}