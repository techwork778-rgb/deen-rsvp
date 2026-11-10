/* Core: server calls, live sync loop, event header, shared helpers. The dashboard is drawn in app-board.js. */
'use strict';

const STATUSES = ['Confirmed', 'Maybe', 'Awaiting', 'Declined'];
const INTERESTS = ['Studio / 1 BR', '2 BR', '3 BR+', 'Villa / Townhouse', 'Investment', 'Commercial', 'Not sure yet'];
const BUDGETS = ['Under AED 1M', 'AED 1M - 2M', 'AED 2M - 5M', 'AED 5M+'];
const POLL_VISIBLE = 8000;
const POLL_HIDDEN = 30000;
const TZ = 'Asia/Dubai';
const AUTH_KEY = 'deen-openhouse-auth';
// Set by build.mjs for the copy hosted outside Google; empty when Apps Script serves the page itself.
const API_URL = '__API_URL__';
const PAGE_URL = API_URL ? location.origin + location.pathname : '';
const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const S = {
  event: null, agentNames: [], board: null, mine: null, auth: null, view: 'board', boardKey: '', boardKeyBad: false, ceoLink: false,
  boardV: '', mineV: '', lastOk: 0, failures: 0, timer: 0, syncing: false, epoch: 0, skew: 0,
  feedKeys: null, shownDay: '', photos: {}, photosV: '', prevRanks: null, leaderId: '', prevConfirmed: null,
  filter: 'all', agentFilter: '', eventFilter: '', query: '',
  editing: null, editingAgent: null, party: 1, pick: null, eventDirty: false, openSheet: null
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const isAdmin = () => !!(S.mine && S.mine.who && S.mine.who.role === 'admin');
/** Anyone signed in (the CEO or an agent), or anyone who opened a valid dashboard link. */
const canSeeBoard = () => !!S.board && (!!(S.mine && S.mine.who) || (!!S.boardKey && !S.boardKeyBad));

const store = {
  get(k) {
    try { return JSON.parse(localStorage.getItem(k) || sessionStorage.getItem(k) || 'null'); } catch (e) { return null; }
  },
  set(k, v, keep) {
    try {
      (keep ? localStorage : sessionStorage).setItem(k, JSON.stringify(v));
      (keep ? sessionStorage : localStorage).removeItem(k);
    } catch (e) { /* private mode: stay signed in for this visit only */ }
  },
  kept(k) {
    try { return !!localStorage.getItem(k); } catch (e) { return false; }
  },
  del(k) {
    try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) { /* nothing stored */ }
  }
};

/* ---------- server ---------- */

const offlineMsg = (err) => (navigator.onLine === false
  ? 'You are offline. Check your connection and try again.'
  : 'Could not reach the server. Try again in a moment.' + (err && err.message ? ' (' + err.message + ')' : ''));

function call(action, payload) {
  if (window.google && google.script && google.script.run) return callGas(action, payload);
  if (!API_URL) return Promise.reject(new Error('Open this page from the app link.'));
  // text/plain keeps this a "simple" request: no preflight, and no Google cookies are sent
  return fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, payload }) })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); },
      (err) => { throw new Error(offlineMsg(err)); })
    .then((res) => {
      if (!res) throw new Error('No answer from the server. Try again.');
      if (!res.ok) throw new Error(res.error);
      return res.data;
    });
}

function callGas(action, payload) {
  return new Promise((resolve, reject) => {
    google.script.run
      .withSuccessHandler((res) => {
        if (!res) reject(new Error('No answer from the server. Try again.'));
        else if (res.ok) resolve(res.data);
        else reject(new Error(res.error));
      })
      .withFailureHandler((err) => reject(new Error(offlineMsg(err))))
      .api(action, payload);
  });
}

/** Applies the public part every answer carries: event details, sign-in names, server clock. */
function applyPublic(res) {
  if (res.now) S.skew = res.now - Date.now();
  if (res.agentNames) {
    S.agentNames = res.agentNames;
    if (S.openSheet === 'sheet-signin') renderNames();
  }
  if (res.event) applyEvent(res.event);
}

/** Runs a write, then applies the fresh lists it returns. */
async function write(action, payload) {
  const res = await call(action, Object.assign({ auth: S.auth }, payload));
  S.epoch++;
  if (res.auth) {
    S.auth = res.auth;
    store.set(AUTH_KEY, res.auth, store.kept(AUTH_KEY));
  }
  applyPublic(res);
  applyBoard(res.board);
  applyMine(res.mine);
  return res;
}

async function sync() {
  if (S.syncing) return;
  S.syncing = true;
  clearTimeout(S.timer);
  const epoch = S.epoch;
  try {
    const res = await call('sync', { boardV: S.boardV, mineV: S.mineV, auth: S.auth, boardKey: S.boardKey });
    S.lastOk = Date.now();
    S.failures = 0;
    setLive(true);
    if (epoch === S.epoch) {
      if (res.boardKeyBad !== S.boardKeyBad) {
        S.boardKeyBad = !!res.boardKeyBad;
        if (S.boardKeyBad && !isAdmin()) { S.board = null; S.boardV = ''; }
        if (S.mine || S.event) applyAuthUi();
      }
      applyPublic(res);
      if (res.signedOut) signOut(res.signedOut);
      else {
        applyBoard(res.board);
        applyMine(res.mine);
      }
      if (res.photosV && res.photosV !== S.photosV) loadPhotos();
    }
  } catch (e) {
    S.failures++;
    setLive(false);
    if (!S.event) $('bootText').textContent = (e && e.message) ? e.message : 'Can\'t reach the server yet. Retrying...';
  } finally {
    S.syncing = false;
    schedule();
  }
}

function schedule() {
  clearTimeout(S.timer);
  const base = document.visibilityState === 'hidden' ? POLL_HIDDEN : POLL_VISIBLE;
  const wait = S.failures ? Math.min(60000, base * Math.pow(1.6, S.failures)) : base;
  S.timer = setTimeout(sync, wait);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sync();
});

function setLive(ok) {
  $('live').classList.toggle('off', !ok);
  $('liveText').textContent = ok ? 'Live' : (S.event ? 'Reconnecting' : 'Connecting');
}

/* ---------- time + formatting (all event times are Dubai time) ---------- */

const now = () => Date.now() + S.skew;

/** Today in Dubai as YYYY-MM-DD, from the server's clock so a wrong phone clock doesn't matter. */
const todayDubai = () => new Date(now()).toLocaleDateString('en-CA', { timeZone: TZ });

/** The date the page shows: every day = today (or the first day while it's still ahead); otherwise the fixed date. */
const eventDate = (ev) => {
  if (!ev.daily) return ev.date;
  const today = todayDubai();
  return ev.date && ev.date > today ? ev.date : today;
};

function eventWindow(ev) {
  const date = ev && eventDate(ev);
  if (!date) return null;
  const start = new Date(date + 'T' + ev.start + ':00' + (ev.offset || '+04:00')).getTime();
  let end = new Date(date + 'T' + ev.end + ':00' + (ev.offset || '+04:00')).getTime();
  if (end <= start) end += 86400000;
  return { start, end };
}

function fmt12(hhmm) {
  if (!hhmm) return '';
  const p = hhmm.split(':').map(Number);
  const h = p[0] % 12 || 12;
  return h + ':' + String(p[1]).padStart(2, '0') + ' ' + (p[0] >= 12 ? 'PM' : 'AM');
}

function fmtLongDate(ymd) {
  return new Date(ymd + 'T12:00:00+04:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
}

function fmtShortDate(ymd) {
  return new Date(ymd + 'T12:00:00+04:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
}

function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
}

function ago(ms) {
  const s = Math.max(0, Math.round((now() - ms) / 1000));
  if (s < 45) return 'now';
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

function fmtMobile(m) {
  const d = String(m || '').replace(/\D/g, '');
  const x = d.match(/^971(5\d)(\d{3})(\d{4})$/) || d.match(/^971(\d)(\d{3})(\d{4})$/);
  if (x) return '+971 ' + x[1] + ' ' + x[2] + ' ' + x[3];
  return d ? '+' + d : '';
}

/* ---------- event header (everyone) ---------- */

function applyEvent(ev) {
  S.event = ev;
  $('boot').hidden = true;
  $('eventBlock').hidden = false;
  $('evName').textContent = ev.name;
  $('evTag').textContent = ev.tagline || '';
  $('evTag').hidden = !ev.tagline;
  document.title = ev.name + ' · RSVP';
  renderEventText();
  if (S.board) renderBoard();
  tick();
}

/** Date, hours and venue lines. Re-run at midnight for an every-day open house. */
function renderEventText() {
  const ev = S.event;
  const date = eventDate(ev);
  const hours = fmt12(ev.start) + ' to ' + fmt12(ev.end);
  S.shownDay = todayDubai();
  setMeta('evDate', date ? fmtLongDate(date) : 'Date to be announced', !date);
  const fromLater = ev.daily && ev.date && ev.date > S.shownDay;
  setMeta('evTime', hours + (ev.daily ? ' · open every day' + (fromLater ? ' from ' + fmtShortDate(ev.date) : '') : ''), false);
  setMeta('evVenue', ev.venue || 'Venue to be announced', !ev.venue);
  $('mineEvent').textContent = [ev.name, date ? fmtShortDate(date) : 'date to be announced', hours, ev.venue].filter(Boolean).join(' · ');
  $('todayTitle').textContent = 'Today · ' + fmtShortDate(S.shownDay);
}

function setMeta(id, text, muted) {
  const n = $(id);
  n.textContent = text;
  n.classList.toggle('muted', muted);
}

/* Dashboard drawing (countdown, ranking, feed) lives in app-board.js. */

/* ---------- toast, dialogs, buttons ---------- */

function toast(html, ms) {
  const t = $('toast');
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms || 4000);
}

function openSheet(id) {
  if (S.openSheet && S.openSheet !== id) closeSheet(S.openSheet);
  $(id).hidden = false;
  S.openSheet = id;
  document.body.style.overflow = 'hidden';
  const first = $(id).querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), select');
  if (first && window.innerWidth > 640) setTimeout(() => first.focus(), 60);
}

function closeSheet(id) {
  $(id).hidden = true;
  if (S.openSheet === id) S.openSheet = null;
  document.body.style.overflow = '';
}

document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]');
  if (c) closeSheet(c.closest('.sheet').id);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (S.openSheet) closeSheet(S.openSheet);
  else if (document.body.classList.contains('tv')) setTv(false);
});

function busy(btn, on, label) {
  if (on) {
    btn.dataset.html = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = label || 'Saving';
  } else {
    btn.disabled = false;
    if (btn.dataset.html) btn.innerHTML = btn.dataset.html;
  }
}

function showErr(id, msg) {
  const n = $(id);
  n.textContent = msg || '';
  n.hidden = !msg;
}

/* ---------- TV mode (CEO or dashboard link): dashboard only, full screen, screen kept awake ---------- */

let wakeLock = null;
function setTv(on) {
  if (on && !canSeeBoard()) return;
  document.body.classList.toggle('tv', on);
  if (on) {
    setView('board');
    try { const r = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); if (r) r.catch(() => {}); } catch (e) { /* not allowed in this frame */ }
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then((l) => { wakeLock = l; }).catch(() => {}); } catch (e) { /* optional */ }
    toast('TV mode. Press Esc or tap the logo to exit.', 3500);
  } else {
    try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (e) { /* ignore */ }
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
}
