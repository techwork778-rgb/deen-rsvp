/** @OnlyCurrentDoc */
/**
 * DEEN Properties - Open House RSVP
 *
 * The Google Sheet this script is attached to is the database:
 *   RSVPs     one row per invited guest (their party), with the agent's name
 *   Agents    who may sign in: the agent's name and their ID (what they type to sign in)
 *   Settings  event details, opening hours (daily or one date), CEO PIN
 *   Activity  every change, newest at the bottom (feeds the live dashboard)
 *
 * Agents see and change only their own guests. The live dashboard, every guest, the agents
 * and the event settings are for the CEO (CEO PIN) only.
 *
 * Deploy: Deploy > New deployment > Web app > Execute as "Me", Who has access "Anyone".
 * Everyone uses the web app link. Only the sheet owner opens the sheet itself.
 */

const STATUSES = ['Confirmed', 'Maybe', 'Awaiting', 'Declined'];
const INTERESTS = ['Studio / 1 BR', '2 BR', '3 BR+', 'Villa / Townhouse', 'Investment', 'Commercial', 'Not sure yet'];
const BUDGETS = ['Under AED 1M', 'AED 1M - 2M', 'AED 2M - 5M', 'AED 5M+'];
const FEED_ACTIONS = { added: 1, status: 1, 'checked in': 1 };
const MAX_TRIES = 5;          // wrong tries before a 10-minute lock
const DATA_TTL = 20;          // seconds the sheet snapshot is cached (manual sheet edits show within this)
const PHOTOS_TTL = 60;        // same for the Photos tab (photos changed in the app show at once)
const DT = 'dd mmm yyyy hh:mm';

const TABS = {
  rsvps: {
    name: 'RSVPs',
    head: ['ID', 'Created', 'Updated', 'Agent name', 'Guest name', 'Mobile', 'Party size', 'Status',
      'Arrival time', 'Interested in', 'Budget', 'Notes', 'Checked in', 'Checked in by'],
    formats: ['@', DT, DT, '@', '@', '@', '0', '@', '@', '@', '@', '@', DT, '@'],
    widths: [90, 130, 130, 160, 180, 140, 80, 100, 90, 130, 120, 260, 130, 120]
  },
  agents: {
    name: 'Agents',
    head: ['Name', 'ID'],
    formats: ['@', '@'],
    widths: [220, 160]
  },
  settings: {
    name: 'Settings',
    head: ['Key', 'Value', 'What it is'],
    formats: ['@', '@', '@'],
    widths: [130, 260, 420]
  },
  photos: {
    name: 'Photos',
    head: ['Name', 'Photo'],
    formats: ['@', '@'],
    widths: [220, 420]
  },
  log: {
    name: 'Activity',
    head: ['Time', 'Who', 'Action', 'Guest', 'Party size', 'Status', 'RSVP ID', 'Details'],
    formats: [DT, '@', '@', '@', '0', '@', '@', '@'],
    widths: [130, 140, 100, 180, 80, 100, 90, 260]
  }
};

const SETTINGS = [
  ['event_name', 'DEEN Open House', 'Title shown in the app'],
  ['tagline', '', 'Short line under the title, e.g. the project name (optional)'],
  ['date', 'daily', 'daily = open every day (shows today\'s date). "daily from 2026-11-14" = every day starting that date. Or one fixed date as YYYY-MM-DD'],
  ['start_time', '09:00', 'Opens, 24-hour Dubai time'],
  ['end_time', '22:00', 'Closes, 24-hour Dubai time'],
  ['venue', '', 'Where it happens'],
  ['rsvp_open', 'yes', 'yes = agents can add and edit RSVPs, no = locked (check-in still works)'],
  ['board_key', '', 'Secret part of the dashboard link. Change it (Event tab > New dashboard link) to switch old dashboard links off.'],
  ['admin_pin', '', 'CEO PIN for the dashboard and settings (6 digits). Keep this sheet private.']
];

/* ---------- entry points ---------- */

function doGet() {
  ensureReady_();
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('DEEN Open House RSVP')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/**
 * JSON API for the copy of the page hosted outside Google (GitHub Pages): POST {action, payload}.
 * Browsers call it without Google cookies, so it works however many Google accounts are signed in.
 */
function doPost(e) {
  ensureReady_();
  let req = {};
  try { req = JSON.parse(e && e.postData ? e.postData.contents : '{}') || {}; } catch (err) { req = {}; }
  return ContentService.createTextOutput(JSON.stringify(api(req.action, req.payload)))
    .setMimeType(ContentService.MimeType.JSON);
}

/** The only function the web page calls: google.script.run.api(action, payload), or doPost above. */
function api(action, payload) {
  try {
    const fn = ACTIONS[action];
    if (!fn) throw userError_('Unknown action.');
    return { ok: true, data: fn(payload || {}) };
  } catch (e) {
    return { ok: false, error: e && e.userFacing ? e.message : 'Server error: ' + (e && e.message ? e.message : e) };
  }
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Open House')
    .addItem('Set up or repair tabs', 'setup')
    .addItem('Show app link and CEO PIN', 'showAppInfo')
    .addToUi();
}

function setup() {
  Object.keys(TABS).forEach(sheet_);
  ensureSettings_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone('Asia/Dubai');
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
  invalidate_();
  CacheService.getScriptCache().put('ready2', '1', 21600);
  return 'ok';
}

function showAppInfo() {
  let url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
  const s = readSettings_();
  SpreadsheetApp.getUi().alert('Open House RSVP',
    (url ? 'App link: ' + url : 'App link: deploy first (Deploy > New deployment > Web app).') +
    '\n\nCEO PIN: ' + s.adminPin, SpreadsheetApp.getUi().ButtonSet.OK);
}

const ACTIONS = {
  sync: sync_,
  login: login_,
  saveRsvp: saveRsvp_,
  deleteRsvp: deleteRsvp_,
  checkIn: checkIn_,
  saveAgent: saveAgent_,
  deleteAgent: deleteAgent_,
  saveEvent: saveEvent_,
  photos: photos_,
  savePhoto: savePhoto_
};

/* ---------- actions ---------- */

/**
 * Event details and agent names for everyone; the caller's own list when signed in.
 * The dashboard goes to everyone signed in (the CEO and the agents), or to anyone opening the
 * dashboard link (?board=<board_key>). It never holds phone numbers or full guest names.
 */
function sync_(p) {
  const d = loadData_();
  const out = publicView_(d);
  let showBoard = !!(p.boardKey && d.settings.boardKey && String(p.boardKey) === d.settings.boardKey);
  if (p.boardKey && !showBoard) out.boardKeyBad = true;
  if (p.auth && p.auth.id) {
    let who = null;
    try { who = auth_(d, p.auth, false); } catch (e) { out.signedOut = e.message; }
    if (who) {
      const mine = mineView_(d, who);
      out.mine = mine.v === p.mineV ? { v: mine.v, same: true } : mine;
      showBoard = true;                                   // agents get the Dashboard tab too
    }
  }
  if (showBoard) {
    const board = boardView_(d);
    out.board = board.v === p.boardV ? { v: board.v, same: true } : board;
  }
  if (showBoard || out.mine) out.photosV = loadPhotos_().v;
  return out;
}

/** Agent photos (name -> small data URL) for the dashboard link or anyone signed in. Never in the public view. */
function photos_(p) {
  const d = loadData_();
  let ok = !!(p.boardKey && d.settings.boardKey && String(p.boardKey) === d.settings.boardKey);
  if (!ok && p.auth && p.auth.id) {
    try { auth_(d, p.auth, false); ok = true; } catch (e) { ok = false; }
  }
  if (!ok) throw userError_('Open the dashboard link or sign in to see photos.');
  return loadPhotos_();
}

function savePhoto_(p) {
  return withLock_(function () {
    const d = readData_();
    const who = auth_(d, p.auth, true);
    if (who.role !== 'admin') throw userError_('Only the CEO can change agent photos.');
    const ag = findAgent_(d, p.name);
    if (!ag) throw userError_('This agent is no longer on the list.');
    const url = String(p.photo == null ? '' : p.photo).trim();
    if (url && !PHOTO_RE.test(url)) throw userError_('That photo could not be read. Try a JPG or PNG.');
    if (url.length > 45000) throw userError_('That photo is too large. Try a smaller picture.');
    upsertPhoto_(ag.name, url);
    log_(who.name, url ? 'photo updated' : 'photo removed', { name: ag.name }, '', '');
    return afterWrite_(who);
  });
}

function login_(p) {
  const d = loadData_();
  const who = auth_(d, p.auth, true);
  return fullView_(d, who);
}

function saveRsvp_(p) {
  return withLock_(function () {
    const d = readData_();
    const who = auth_(d, p.auth, true);
    const isAdmin = who.role === 'admin';
    if (!isAdmin && !d.settings.open) throw userError_('RSVPs are closed. Ask the CEO to reopen them.');
    const input = cleanRsvp_(p.rsvp || {});

    let existing = null;
    if (input.id) {
      existing = d.rsvps.find(function (r) { return r.id === input.id; });
      if (!existing) throw userError_('This RSVP no longer exists. It may have been removed.');
      if (!isAdmin && existing.agentKey !== nameKey_(who.name)) throw userError_('You can only change your own RSVPs.');
    }

    let owner = existing ? existing.agent : who.name;
    if (isAdmin) {
      const target = findAgent_(d, input.agentName);
      if (target) owner = target.name;
      else if (!existing) throw userError_('Choose the agent this guest belongs to.');
    }

    const key = input.mobile.slice(1);
    const dupe = d.rsvps.find(function (r) { return r.id !== input.id && normMobile_(r.mobile).slice(1) === key; });
    if (dupe) {
      if (isAdmin) throw userError_('This number is already on the list: ' + dupe.name + ', under ' + (dupe.agent || 'no agent') + '. Edit that RSVP instead.');
      if (dupe.agentKey === nameKey_(who.name)) throw userError_('You already have ' + dupe.name + ' on your list with this number.');
      throw userError_((dupe.agent || 'Another agent') + ' already registered this number (' + maskName_(dupe.name) + '). Ask the CEO if it should move to you.');
    }

    const now = new Date();
    const sh = sheet_('rsvps');
    if (existing) {
      writeRow_('rsvps', sh, existing.row, [existing.id, toDate_(existing.created) || now, now, owner,
        input.name, input.mobile, input.party, input.status, input.arrival, input.interest, input.budget, input.notes,
        toDate_(existing.checkedIn) || '', existing.checkedBy || '']);
      const changed = existing.status !== input.status;
      const moved = nameKey_(existing.agent) !== nameKey_(owner);
      log_(who.name, changed ? 'status' : 'updated', input, existing.id,
        (changed ? existing.status + ' > ' + input.status : '') + (moved ? (changed ? '; ' : '') + 'moved from ' + existing.agent + ' to ' + owner : ''));
    } else {
      const id = newId_('R');
      writeRow_('rsvps', sh, sh.getLastRow() + 1, [id, now, now, owner, input.name, input.mobile,
        input.party, input.status, input.arrival, input.interest, input.budget, input.notes, '', '']);
      log_(who.name, 'added', input, id, isAdmin ? 'for ' + owner : '');
    }
    return afterWrite_(who);
  });
}

function deleteRsvp_(p) {
  return withLock_(function () {
    const d = readData_();
    const who = auth_(d, p.auth, true);
    const r = d.rsvps.find(function (x) { return x.id === p.id; });
    if (!r) throw userError_('This RSVP was already removed.');
    if (who.role !== 'admin' && r.agentKey !== nameKey_(who.name)) throw userError_('You can only remove your own RSVPs.');
    if (who.role !== 'admin' && !d.settings.open) throw userError_('RSVPs are closed. Ask the CEO to reopen them.');
    sheet_('rsvps').deleteRow(r.row);
    log_(who.name, 'removed', r, r.id, r.mobile);
    return afterWrite_(who);
  });
}

function checkIn_(p) {
  return withLock_(function () {
    const d = readData_();
    const who = auth_(d, p.auth, true);
    const r = d.rsvps.find(function (x) { return x.id === p.id; });
    if (!r) throw userError_('This RSVP no longer exists.');
    if (who.role !== 'admin' && r.agentKey !== nameKey_(who.name)) throw userError_('Only ' + (r.agent || 'its agent') + ' or the CEO can check this guest in.');
    sheet_('rsvps').getRange(r.row, 13, 1, 2).setNumberFormats([[DT, '@']]).setValues([p.arrived ? [new Date(), who.name] : ['', '']]);
    log_(who.name, p.arrived ? 'checked in' : 'check-in undone', r, r.id, '');
    return afterWrite_(who);
  });
}

function saveAgent_(p) {
  return withLock_(function () {
    const d = readData_();
    const who = auth_(d, p.auth, true);
    if (who.role !== 'admin') throw userError_('Only the CEO can change agents.');
    const a = p.agent || {};
    const name = str_(a.name, 40).replace(/^[=+\-@]+/, '');
    if (name.length < 2) throw userError_('Add the agent\'s name.');
    if (/^(admin|manager|ceo)$/i.test(name)) throw userError_('"' + name + '" is reserved. Use the agent\'s real name.');
    const code = str_(a.code, 30).replace(/^[=+\-@]+/, '');
    if (codeKey_(code).length < 3) throw userError_('The ID needs at least 3 characters, e.g. 4821 or DP07.');

    const existing = a.original ? findAgent_(d, a.original) : null;
    if (a.original && !existing) throw userError_('This agent is no longer on the list.');
    const clash = d.agents.find(function (x) { return x !== existing && x.key === nameKey_(name); });
    if (clash) throw userError_('There is already an agent called ' + clash.name + '.');
    const codeClash = d.agents.find(function (x) { return x !== existing && codeKey_(x.code) === codeKey_(code); });
    if (codeClash) throw userError_(codeClash.name + ' already uses this ID. Give each agent a different one.');

    const sh = sheet_('agents');
    if (existing) {
      writeRow_('agents', sh, existing.row, [name, code]);
      if (existing.name !== name) {
        const rs = sheet_('rsvps');
        d.rsvps.forEach(function (r) { if (r.agentKey === existing.key) rs.getRange(r.row, 4).setNumberFormat('@').setValue(name); });
        renamePhoto_(existing.name, name);
      }
      log_(who.name, 'agent updated', { name: name }, '', existing.name !== name ? 'renamed from ' + existing.name : '');
    } else {
      writeRow_('agents', sh, sh.getLastRow() + 1, [name, code]);
      log_(who.name, 'agent added', { name: name }, '', '');
    }
    return afterWrite_(who);
  });
}

function deleteAgent_(p) {
  return withLock_(function () {
    const d = readData_();
    const who = auth_(d, p.auth, true);
    if (who.role !== 'admin') throw userError_('Only the CEO can remove agents.');
    const ag = findAgent_(d, p.name);
    if (!ag) throw userError_('This agent was already removed.');
    sheet_('agents').deleteRow(ag.row);
    upsertPhoto_(ag.name, '');
    log_(who.name, 'agent removed', { name: ag.name }, '', 'their guests stay on the list');
    return afterWrite_(who);
  });
}

function saveEvent_(p) {
  return withLock_(function () {
    const d = readData_();
    const who = auth_(d, p.auth, true);
    if (who.role !== 'admin') throw userError_('Only the CEO can change the event.');
    const e = p.event || {};
    const daily = !!e.daily;
    const date = e.date ? normDate_(e.date) : '';
    if (e.date && !date) throw userError_('Use a real date, e.g. 2026-11-20.');
    const start = normTime_(e.start), end = normTime_(e.end);
    if (!start || !end) throw userError_('Add an opening and closing time.');
    const values = {
      event_name: str_(e.name, 60) || 'DEEN Open House',
      tagline: str_(e.tagline, 80),
      date: daily ? (date ? 'daily from ' + date : 'daily') : date,
      start_time: start,
      end_time: end,
      venue: str_(e.venue, 120),
      rsvp_open: e.open ? 'yes' : 'no'
    };
    if (e.adminPin) {
      if (!/^\d{6,8}$/.test(String(e.adminPin))) throw userError_('The CEO PIN must be 6 to 8 digits.');
      values.admin_pin = String(e.adminPin);
    }
    if (e.newBoardKey) values.board_key = newKey_();
    writeSettings_(values);
    log_(who.name, 'event updated', { name: values.event_name }, '',
      [e.adminPin ? 'CEO PIN changed' : '', e.newBoardKey ? 'new dashboard link' : ''].filter(String).join('; '));
    const out = afterWrite_(who);
    out.auth = e.adminPin ? { id: 'admin', pin: String(e.adminPin) } : p.auth;
    return out;
  });
}

/* ---------- views (what leaves the server) ---------- */

/** Safe for anyone with the link: event details and the names on the sign-in list. */
function publicView_(d) {
  return { event: publicEvent_(d.settings), agentNames: d.agents.map(function (a) { return a.name; }), now: Date.now() };
}

function fullView_(d, who) {
  const out = publicView_(d);
  out.mine = mineView_(d, who);
  out.board = boardView_(d);                              // CEO and agents both see the dashboard
  return out;
}

function boardView_(d) {
  const per = {};
  d.agents.forEach(function (a) {
    per[a.key] = { id: a.name, name: a.name, active: true, confirmed: 0, parties: 0, arrived: 0, today: 0, todayConfirmed: 0 };
  });
  const t = { parties: 0, confirmed: 0, confirmedParties: 0, maybe: 0, awaiting: 0, declined: 0, arrived: 0, arrivedParties: 0,
    todayNew: 0, todayConfirmed: 0, todayArrived: 0 };
  const today = dubaiDay_(Date.now());
  d.rsvps.forEach(function (r) {
    const k = r.agentKey || '-';
    const a = per[k] || (per[k] = { id: r.agent || 'No agent', name: r.agent || 'No agent', active: false, confirmed: 0, parties: 0, arrived: 0, today: 0, todayConfirmed: 0 });
    t.parties++; a.parties++;
    if (r.status === 'Confirmed') { t.confirmed += r.party; t.confirmedParties++; a.confirmed += r.party; }
    else if (r.status === 'Maybe') t.maybe += r.party;
    else if (r.status === 'Awaiting') t.awaiting++;
    else if (r.status === 'Declined') t.declined++;
    if (r.checkedIn) { t.arrived += r.party; t.arrivedParties++; a.arrived += r.party; }
    if (r.created && dubaiDay_(r.created) === today) {
      t.todayNew++; a.today++;
      if (r.status === 'Confirmed') { t.todayConfirmed += r.party; a.todayConfirmed += r.party; }
    }
    if (r.checkedIn && dubaiDay_(r.checkedIn) === today) t.todayArrived += r.party;
  });
  const agents = Object.keys(per).map(function (k) { return per[k]; }).sort(function (a, b) {
    return b.confirmed - a.confirmed || b.parties - a.parties || b.arrived - a.arrived || a.name.localeCompare(b.name);
  });
  const feed = d.log.filter(function (l) { return FEED_ACTIONS[l.action]; }).slice(-14).reverse().map(function (l) {
    return { t: l.t, who: l.who, action: l.action, guest: maskName_(l.guest), party: l.party, status: l.status };
  });
  const view = { totals: t, agents: agents, feed: feed };
  view.v = hash_(JSON.stringify(view));
  return view;
}

function mineView_(d, who) {
  const isAdmin = who.role === 'admin';
  const me = nameKey_(who.name);
  const rows = d.rsvps.filter(function (r) { return isAdmin || r.agentKey === me; }).map(function (r) {
    return { id: r.id, created: r.created, updated: r.updated, agent: r.agent, name: r.name, mobile: r.mobile,
      party: r.party, status: r.status, arrival: r.arrival, interest: r.interest, budget: r.budget,
      notes: r.notes, checkedIn: r.checkedIn, checkedBy: r.checkedBy };
  });
  const out = { who: who, open: d.settings.open, rsvps: rows };
  if (isAdmin) {
    out.agents = d.agents.map(function (a) { return { name: a.name, code: a.code }; });
    out.settings = publicEvent_(d.settings);
    out.boardKey = d.settings.boardKey;
  }
  out.v = hash_(JSON.stringify(out));
  if (isAdmin) {
    out.sheetUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();
    try { out.appUrl = ScriptApp.getService().getUrl() || ''; } catch (e) { out.appUrl = ''; }
  }
  return out;
}

function publicEvent_(s) {
  return { name: s.name, tagline: s.tagline, date: s.date, daily: s.daily, start: s.start, end: s.end, venue: s.venue,
    open: s.open, offset: '+04:00' };
}

function afterWrite_(who) {
  SpreadsheetApp.flush();
  invalidate_();
  return fullView_(loadData_(), who);
}

/* ---------- auth ---------- */

/** a = { id: 'admin' or the agent's name, pin: the CEO PIN or the agent's ID }. */
function auth_(d, a, countFailure) {
  if (!a || !a.id) throw userError_('Please sign in first.');
  const key = nameKey_(a.id);
  const cache = CacheService.getScriptCache();
  const failKey = 'fail:' + key.slice(0, 80);
  const fails = Number(cache.get(failKey) || 0);
  const locked = 'Too many wrong tries. Wait 10 minutes or ask the CEO to check your ID.';
  if (fails >= MAX_TRIES) throw userError_(locked);
  let who = null;
  if (key === 'admin') {
    const pin = String(a.pin == null ? '' : a.pin).trim();
    if (d.settings.adminPin && pin === d.settings.adminPin) who = { id: 'admin', name: 'CEO', role: 'admin' };
  } else {
    const ag = findAgent_(d, a.id);
    if (!ag) throw userError_('Your name is not on the agents list. Ask the CEO to add you.');
    if (ag.code && codeKey_(a.pin) === codeKey_(ag.code)) who = { id: ag.name, name: ag.name, role: 'agent' };
  }
  if (!who) {
    if (!countFailure) throw userError_('Your sign-in details changed. Sign in again.');
    cache.put(failKey, String(fails + 1), 600);
    const left = MAX_TRIES - fails - 1;
    const what = key === 'admin' ? 'PIN' : 'ID';
    throw userError_(left > 0 ? 'Wrong ' + what + '. ' + left + (left === 1 ? ' try' : ' tries') + ' left.' : locked);
  }
  if (fails && countFailure) cache.remove(failKey);
  return who;
}

function findAgent_(d, name) {
  const key = nameKey_(name);
  return key ? d.agents.find(function (a) { return a.key === key; }) || null : null;
}

/* ---------- reading the sheet ---------- */

function loadData_() {
  const cached = cacheGetJson_('data');
  if (cached) return cached;
  const d = readData_();
  cachePutJson_('data', d, DATA_TTL);
  return d;
}

function readData_() {
  return { settings: readSettings_(), agents: readAgents_(), rsvps: readRsvps_(), log: readLog_(40), at: Date.now() };
}

function readRsvps_() {
  const sh = sheet_('rsvps');
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, TABS.rsvps.head.length).getValues();
  const out = [];
  values.forEach(function (r, i) {
    const name = str_(r[4], 80);
    if (!name) return;
    let id = str_(r[0], 40);
    if (!id) { id = newId_('R'); sh.getRange(i + 2, 1).setNumberFormat('@').setValue(id); }
    const agent = str_(r[3], 40);
    out.push({
      row: i + 2, id: id, created: ms_(r[1]), updated: ms_(r[2]), agent: agent, agentKey: nameKey_(agent),
      name: name, mobile: normMobile_(r[5]) || str_(r[5], 20), party: Math.max(1, Math.round(Number(r[6])) || 1),
      status: normStatus_(r[7]), arrival: normTime_(r[8]), interest: str_(r[9], 40), budget: str_(r[10], 40),
      notes: str_(r[11], 500), checkedIn: ms_(r[12]), checkedBy: str_(r[13], 40)
    });
  });
  return out;
}

function readAgents_() {
  const sh = sheet_('agents');
  const last = sh.getLastRow();
  if (last < 2) return [];
  const seen = {};
  const out = [];
  sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r, i) {
    const name = str_(r[0], 40);
    const key = nameKey_(name);
    if (!name || seen[key]) return;
    seen[key] = 1;
    out.push({ row: i + 2, name: name, key: key, code: str_(r[1], 30) });
  });
  return out;
}

function readSettings_() {
  const sh = sheet_('settings');
  const last = sh.getLastRow();
  const map = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) { map[str_(r[0], 40)] = r[1]; });
  // "daily", "daily from 2026-11-14" (every day from that date) or one fixed date
  const rawDate = String(map.date == null ? '' : map.date).trim();
  const dm = rawDate.match(/^(?:daily|every ?day|today)(?:\s+from\s+(.+))?$/i);
  return {
    name: str_(map.event_name, 60) || 'DEEN Open House',
    tagline: str_(map.tagline, 80),
    date: dm ? (dm[1] ? normDate_(dm[1]) : '') : normDate_(map.date),
    daily: !!dm,
    start: normTime_(map.start_time) || '09:00',
    end: normTime_(map.end_time) || '22:00',
    venue: str_(map.venue, 120),
    open: !/^(no|false|n|0|closed|locked)$/i.test(String(map.rsvp_open == null ? 'yes' : map.rsvp_open).trim()),
    boardKey: str_(map.board_key, 40),
    adminPin: str_(map.admin_pin, 12)
  };
}

const PHOTO_RE = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+\/=]+$/;

/** Photos tab: agent name -> small data:image URL (set from the CEO's Agents tab). */
function readPhotos_() {
  const sh = sheet_('photos');
  const last = sh.getLastRow();
  const map = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
    const key = nameKey_(r[0]);
    const url = String(r[1] == null ? '' : r[1]).trim();
    if (key && url.length < 50000 && PHOTO_RE.test(url)) map[key] = url;
  });
  return map;
}

/** Cached separately from the main snapshot, so photos are sent only when they change. */
function loadPhotos_() {
  const cached = cacheGetJson_('photos');
  if (cached) return cached;
  const map = readPhotos_();
  const sig = Object.keys(map).sort().map(function (k) { return k + ':' + map[k].length + map[k].slice(-32); }).join('|');
  const out = { v: hash_(sig), map: map };
  cachePutJson_('photos', out, PHOTOS_TTL);
  return out;
}

function upsertPhoto_(name, url) {
  const sh = sheet_('photos');
  const last = sh.getLastRow();
  const keys = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return nameKey_(r[0]); }) : [];
  const i = keys.indexOf(nameKey_(name));
  if (i >= 0 && !url) sh.deleteRow(i + 2);
  else if (i >= 0) writeRow_('photos', sh, i + 2, [name, url]);
  else if (url) writeRow_('photos', sh, last + 1, [name, url]);
  CacheService.getScriptCache().remove('photos');
}

function renamePhoto_(oldName, newName) {
  const sh = sheet_('photos');
  const last = sh.getLastRow();
  if (last < 2) return;
  const keys = sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return nameKey_(r[0]); });
  const i = keys.indexOf(nameKey_(oldName));
  if (i >= 0) sh.getRange(i + 2, 1).setNumberFormat('@').setValue(newName);
  CacheService.getScriptCache().remove('photos');
}

function readLog_(n) {
  const sh = sheet_('log');
  const last = sh.getLastRow();
  if (last < 2) return [];
  const from = Math.max(2, last - n + 1);
  return sh.getRange(from, 1, last - from + 1, 6).getValues().map(function (r) {
    return { t: ms_(r[0]), who: str_(r[1], 40), action: str_(r[2], 20), guest: str_(r[3], 80), party: Number(r[4]) || 0, status: str_(r[5], 20) };
  });
}

/* ---------- writing the sheet ---------- */

function sheet_(key) {
  const spec = TABS[key];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(spec.name);
  if (sh) return sh;
  sh = ss.insertSheet(spec.name);
  sh.getRange(1, 1, 1, spec.head.length).setValues([spec.head])
    .setFontWeight('bold').setBackground('#000000').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  const rows = Math.max(1, sh.getMaxRows() - 1);
  spec.formats.forEach(function (f, i) { if (f) sh.getRange(2, i + 1, rows, 1).setNumberFormat(f); });
  spec.widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  return sh;
}

/** Sets text/date formats first so Sheets keeps "+971...", "0042" and "18:30" exactly as typed. */
function writeRow_(key, sh, row, values) {
  sh.getRange(row, 1, 1, values.length).setNumberFormats([TABS[key].formats]).setValues([values]);
}

function log_(who, action, r, id, detail) {
  const sh = sheet_('log');
  writeRow_('log', sh, sh.getLastRow() + 1, [new Date(), who, action, r.name || '', r.party || '', r.status || '', id || '', detail || '']);
}

function ensureReady_() {
  if (CacheService.getScriptCache().get('ready2')) return;
  setup();
}

function ensureSettings_() {
  const sh = sheet_('settings');
  const last = sh.getLastRow();
  const have = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r, i) { have[str_(r[0], 40)] = { row: i + 2, value: r[1] }; });
  SETTINGS.forEach(function (s) {
    if (!have[s[0]]) {
      const row = sh.getLastRow() + 1;
      sh.getRange(row, 1, 1, 3).setNumberFormats([['@', '@', '@']]).setValues([[s[0], s[1], s[2]]]);
      have[s[0]] = { row: row, value: s[1] };
    }
  });
  if (!str_(have.admin_pin.value, 12)) {
    sh.getRange(have.admin_pin.row, 2).setNumberFormat('@').setValue(String(100000 + Math.floor(Math.random() * 900000)));
  }
  if (!str_(have.board_key.value, 40)) {
    sh.getRange(have.board_key.row, 2).setNumberFormat('@').setValue(newKey_());
  }
}

function writeSettings_(values) {
  ensureSettings_();
  const sh = sheet_('settings');
  const keys = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  keys.forEach(function (k, i) {
    const key = str_(k[0], 40);
    if (Object.prototype.hasOwnProperty.call(values, key)) sh.getRange(i + 2, 2).setNumberFormat('@').setValue(values[key]);
  });
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw userError_('The sheet is busy. Try again in a moment.');
  try {
    return fn();
  } catch (e) {
    invalidate_();
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/* ---------- cache (values are capped at 100 KB, so big snapshots are split) ---------- */

function cacheGetJson_(key) {
  const c = CacheService.getScriptCache();
  const n = Number(c.get(key) || 0);
  if (!n) return null;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(key + ':' + i);
  const parts = c.getAll(keys);
  let s = '';
  for (let i = 0; i < keys.length; i++) {
    if (parts[keys[i]] == null) return null;
    s += parts[keys[i]];
  }
  try { return JSON.parse(s); } catch (e) { return null; }
}

function cachePutJson_(key, obj, ttl) {
  const s = JSON.stringify(obj);
  const map = {};
  let n = 0;
  for (let i = 0; i < s.length; i += 30000) map[key + ':' + (n++)] = s.slice(i, i + 30000);
  map[key] = String(n);
  CacheService.getScriptCache().putAll(map, ttl);
}

function invalidate_() {
  CacheService.getScriptCache().remove('data');
}

/* ---------- cleaning input ---------- */

function cleanRsvp_(r) {
  const name = str_(r.name, 80).replace(/^[=+\-@]+/, '');
  if (name.length < 2) throw userError_('Add the guest\'s name.');
  const mobile = normMobile_(r.mobile);
  if (!mobile) throw userError_('Add a valid mobile number, e.g. 050 123 4567 or +44 7700 900123.');
  const party = Math.round(Number(r.party));
  if (!(party >= 1 && party <= 20)) throw userError_('Party size must be between 1 and 20.');
  if (STATUSES.indexOf(r.status) < 0) throw userError_('Pick a status.');
  const arrival = r.arrival ? normTime_(r.arrival) : '';
  if (r.arrival && !arrival) throw userError_('Arrival time should look like 18:30.');
  return {
    id: str_(r.id, 40), agentName: str_(r.agentName, 40), name: name, mobile: mobile, party: party, status: r.status,
    arrival: arrival,
    interest: INTERESTS.indexOf(r.interest) >= 0 ? r.interest : '',
    budget: BUDGETS.indexOf(r.budget) >= 0 ? r.budget : '',
    notes: str_(r.notes, 500).replace(/^[=+\-@]+/, '')
  };
}

/** Any UAE or international number to +<digits>. 050 123 4567 -> +971501234567 */
function normMobile_(v) {
  let d = String(v == null ? '' : v).trim();
  const plus = d.charAt(0) === '+';
  d = d.replace(/\D/g, '');
  if (!plus && d.indexOf('00') === 0) d = d.slice(2);
  else if (!plus && /^0\d{8,9}$/.test(d)) d = '971' + d.slice(1);
  else if (!plus && /^5\d{8}$/.test(d)) d = '971' + d;
  return /^\d{7,15}$/.test(d) ? '+' + d : '';
}

function normStatus_(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  for (let i = 0; i < STATUSES.length; i++) if (STATUSES[i].toLowerCase() === s) return STATUSES[i];
  if (/^(yes|coming|attending)$/.test(s)) return 'Confirmed';
  if (/^(no|not coming)$/.test(s)) return 'Declined';
  return 'Awaiting';
}

function normDate_(v) {
  if (v instanceof Date && !isNaN(v)) return v.getFullYear() + '-' + pad_(v.getMonth() + 1) + '-' + pad_(v.getDate());
  const s = String(v == null ? '' : v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) {
    m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
    if (m) m = [m[0], m[3], m[2], m[1]];
  }
  if (!m) return '';
  const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
  const check = new Date(Date.UTC(y, mo - 1, da));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== da) return '';
  return y + '-' + pad_(mo) + '-' + pad_(da);
}

function normTime_(v) {
  if (v instanceof Date && !isNaN(v)) return pad_(v.getHours()) + ':' + pad_(v.getMinutes());
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i);
  if (!m) return '';
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3]) { h = h % 12; if (/pm/i.test(m[3])) h += 12; }
  if (h > 23 || min > 59) return '';
  return pad_(h) + ':' + pad_(min);
}

/** Agents are matched by name, ignoring case and extra spaces. */
function nameKey_(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** IDs are compared ignoring case and spaces: "dp 07" signs in as "DP07". */
function codeKey_(v) {
  return String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase();
}

function maskName_(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  return parts.length === 1 ? parts[0] : parts[0] + ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.';
}

function str_(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function ms_(v) {
  if (v instanceof Date) return isNaN(v) ? 0 : v.getTime();
  if (typeof v === 'number') return v > 1e11 ? v : 0;
  const t = Date.parse(String(v || ''));
  return isNaN(t) ? 0 : t;
}

/** Calendar day in Dubai (UTC+4, no daylight saving) as YYYY-MM-DD. */
function dubaiDay_(ms) {
  return new Date(ms + 4 * 3600000).toISOString().slice(0, 10);
}

function toDate_(ms) {
  return ms ? new Date(ms) : null;
}

function pad_(n) {
  return (n < 10 ? '0' : '') + n;
}

function newId_(prefix) {
  return prefix + '-' + Date.now().toString(36).slice(-4).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
}

/** 12 random letters/digits for the dashboard link. */
function newKey_() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let k = '';
  for (let i = 0; i < 12; i++) k += chars.charAt(Math.floor(Math.random() * chars.length));
  return k;
}

function hash_(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

function userError_(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  return e;
}
