/* Dashboard: digital countdown, agent ranking (podium + tier cards), motivation ticker, floating
   Latest feed and celebrations. Tiers follow AgentPerformanceColorTiers.pdf (top 25% Elite, middle
   50% Core, bottom 25% Growth), regraded for Dubai: gold, platinum, bronze. */

const TIER = {
  elite: { label: 'Elite', color: '#E3B35E', soft: 'rgba(227, 179, 94, 0.17)' },
  core: { label: 'Core', color: '#D7DEE8', soft: 'rgba(215, 222, 232, 0.12)' },
  growth: { label: 'Growth', color: '#C98350', soft: 'rgba(201, 131, 80, 0.16)' }
};

/** Who is ahead on the numbers: most confirmed guests, then most RSVPs, then most arrivals (0 = level). */
const rankCmp = (a, b) => b.confirmed - a.confirmed || b.parties - a.parties || b.arrived - a.arrived;

/** Top 25% Elite, middle 50% Core, bottom 25% Growth (12 agents: 3 / 6 / 3). Agents with exactly the
    same numbers share a tier, so the order of names never decides a colour, and Elite needs at least
    one confirmed guest. */
function tierFor(a, agents) {
  const cut = Math.max(1, Math.round(agents.length * 0.25));
  let above = 0, below = 0;
  agents.forEach((o) => {
    const c = rankCmp(o, a);
    if (c < 0) above++;
    else if (c > 0) below++;
  });
  if (a.confirmed > 0 && above < cut) return 'elite';
  if (below < cut) return 'growth';
  return 'core';
}

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th", 22 -> "22nd" */
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/** Every agent gets their own place: most confirmed guests first, then most RSVPs, then most arrivals. */
const byLeader = (a, b) => rankCmp(a, b) || a.name.localeCompare(b.name);

const ICON = {
  crown: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 8l4.6 3.6L12 4.5l4.4 7.1L21 8l-1.8 10.5H4.8z"/><rect x="4.8" y="19.6" width="14.4" height="1.9" rx=".9"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.5 2.5s5 4.4 5 10.1a5.5 5.5 0 0 1-11 0c0-2.4 1.1-4.2 2.3-5.4.1 2.2 1.1 3.5 2.3 3.6-.2-3.4 1.4-6.5 1.4-8.3z"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5a3.5 3.5 0 0 0 4 4.2M16 6h3.5a3.5 3.5 0 0 1-4 4.2M12 13v4M8 20h8"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 2L4 14h6.5l-1 8L19 10h-6.5z"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 5l7.5 9.5h-15z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 19c.8-3.4 3.2-5 6-5s5.2 1.6 6 5M16 5.2a3 3 0 0 1 0 5.6M18 14.4c1.6.7 2.6 2.3 3 4.6"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/></svg>'
};

/* ---------- photos (kept in the company Sheet, loaded for dashboard viewers and signed-in people) ---------- */

const pkey = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
const initials = (name) => {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);
  return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
};

function avatarInner(name) {
  const url = S.photos[pkey(name)];
  return url ? '<img src="' + esc(url) + '" alt="">' : '<b>' + esc(initials(name)) + '</b>';
}

function avatar(name, cls) {
  return '<span class="av' + (cls ? ' ' + cls : '') + '" aria-hidden="true">' + avatarInner(name) + '</span>';
}

/** Redraws an avatar only when its picture changed, so images don't flicker on every update. */
function setAvatar(node, name) {
  const url = S.photos[pkey(name)];
  const k = (url ? 'p' + url.length : 'i') + ':' + pkey(name);
  if (node.dataset.k !== k) {
    node.dataset.k = k;
    node.innerHTML = avatarInner(name);
  }
}

let photosBusy = false;
async function loadPhotos() {
  if (photosBusy) return;
  photosBusy = true;
  try {
    const res = await call('photos', { boardKey: S.boardKey, auth: S.auth });
    S.photos = res.map || {};
    S.photosV = res.v || '';
    if (S.board && S.event) renderBoard();
    if (S.view === 'agents') renderAgents();
    if (S.view === 'mine') renderMine();
  } catch (e) { /* no access or offline: initials stay */ } finally {
    photosBusy = false;
  }
}

/* ---------- board ---------- */

function applyBoard(b) {
  if (!b || b.same) return;
  S.board = b;
  S.boardV = b.v;
  if (S.event) renderBoard();
}

function renderBoard() {
  const b = S.board;
  const t = b.totals;
  $('boardBody').hidden = !canSeeBoard();
  $('welcome').hidden = !!(S.mine && S.mine.who) || canSeeBoard();

  setNum('kConfirmed', t.confirmed);
  setNum('kParties', t.parties);
  setNum('kMaybe', t.maybe);
  setNum('kAwaiting', t.awaiting);
  setNum('kDeclined', t.declined);
  setNum('kArrived', t.arrived);
  setNum('kTodayNew', t.todayNew || 0);
  setNum('kTodayConfirmed', t.todayConfirmed || 0);
  setNum('kTodayArrived', t.todayArrived || 0);
  $('kPartiesNote').textContent = t.confirmedParties + ' confirmed';
  $('kArrivedNote').textContent = t.arrived ? 'of ' + t.confirmed + ' confirmed' : 'people checked in';
  const maybeLine = t.maybe ? ' &middot; ' + plural(t.maybe, 'person says', 'people say') + ' maybe' : '';
  $('capText').innerHTML = (t.confirmedParties ? 'from <b>' + plural(t.confirmedParties, 'RSVP', 'RSVPs') + '</b>' : 'No confirmed RSVPs yet') + maybeLine;

  renderRanking(b.agents);
  renderArrivals(b.arrivals);
  renderTicker(b.agents, t);
  renderFeed(b.feed);
  if (S.prevConfirmed != null && t.confirmed > S.prevConfirmed && S.view === 'board') confetti(60, innerWidth * 0.25, innerHeight * 0.45);
  S.prevConfirmed = t.confirmed;
}

function setNum(id, to) {
  const node = $(id);
  const from = Number(node.dataset.v || 0);
  node.dataset.v = to;
  if (from === to || reducedMotion) { node.textContent = to; return; }
  const t0 = performance.now();
  const dur = 900;
  const step = (ts) => {
    const k = Math.min(1, (ts - t0) / dur);
    node.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1 && node.dataset.v === String(to)) requestAnimationFrame(step);
    else node.textContent = node.dataset.v;
  };
  requestAnimationFrame(step);
  node.classList.remove('pop');
  void node.offsetWidth;
  node.classList.add('pop');
}

/* ---------- agent ranking: top 3 on a podium, everyone else as tier cards ---------- */

function makePod() {
  const el = document.createElement('article');
  el.innerHTML = '<span class="pod-crown">' + ICON.crown + '</span>' +
    '<div class="pod-photo"><i class="pod-ring"></i><span class="av av-xl"></span><b class="pod-medal"></b></div>' +
    '<p class="pod-name"></p><span class="tier-tag"></span>' +
    '<p class="pod-num"><b></b><small></small></p><p class="pod-sub"></p><p class="pod-gap"></p>';
  el.addEventListener('animationend', (e) => { if (e.animationName === 'popIn') el.classList.remove('enter'); });
  return el;
}

function makeRow() {
  const li = document.createElement('li');
  li.innerHTML = '<span class="rk-rank"></span><span class="av"></span>' +
    '<div class="rk-main"><p class="rk-name"></p><span class="rk-bar"><i></i></span><p class="rk-sub"></p></div>' +
    '<p class="rk-num"><b></b><small></small></p>';
  li.addEventListener('animationend', (e) => { if (e.animationName === 'popIn') li.classList.remove('enter'); });
  return li;
}

/** What it takes to move up (or how far ahead the leader is). */
function gapLine(agents, i) {
  const a = agents[i];
  if (i === 0) {
    const second = agents[1];
    if (!second) return '';
    const lead = a.confirmed - second.confirmed;
    if (lead > 0) return 'Leads by ' + plural(lead, 'guest', 'guests');
    return a.confirmed > 0 ? 'Tied at the top' : 'First confirmed guest takes the crown';
  }
  const ahead = agents[i - 1];
  return (ahead.confirmed - a.confirmed + 1) + ' to pass ' + firstName(ahead.name);
}

function fillCard(el, a, rank, tier, gap, onPodium, max) {
  const T = TIER[tier];
  const hot = a.today >= 3;
  const keepEnter = el.classList.contains('enter');
  el.className = (onPodium ? 'pod p' + rank : 'rk') + ' tier-' + tier + (a.active ? '' : ' off') + (hot ? ' hot' : '') + (keepEnter ? ' enter' : '');
  el.style.setProperty('--tier', T.color);
  el.style.setProperty('--tier-soft', T.soft);
  const badge = hot ? '<span class="hot-badge">' + ICON.flame + 'On fire</span>' : '';
  const sub = plural(a.parties, 'RSVP', 'RSVPs') + (a.today ? ' &middot; <b>+' + a.today + ' today</b>' : '') +
    (a.arrived ? ' &middot; ' + a.arrived + ' arrived' : '') + (a.active ? '' : ' &middot; not on the agents list');
  const word = a.confirmed === 1 ? 'guest' : 'guests';
  setAvatar(el.querySelector('.av'), a.name);
  if (onPodium) {
    el.querySelector('.pod-medal').textContent = rank;
    el.querySelector('.pod-name').innerHTML = esc(a.name) + (badge ? ' ' + badge : '');
    el.querySelector('.tier-tag').textContent = T.label;
    el.querySelector('.pod-num b').textContent = a.confirmed;
    el.querySelector('.pod-num small').textContent = word;
    el.querySelector('.pod-sub').innerHTML = sub;
    el.querySelector('.pod-gap').textContent = gap;
  } else {
    el.querySelector('.rk-rank').textContent = ordinal(rank);
    el.querySelector('.rk-name').innerHTML = '<span class="nm">' + esc(a.name) + '</span>' + badge;
    el.querySelector('.rk-num b').textContent = a.confirmed;
    el.querySelector('.rk-num small').textContent = word;
    el.querySelector('.rk-sub').innerHTML = '<span class="tier-tag">' + T.label + '</span><span>' + sub + '</span>' +
      (gap ? '<span class="gap">' + ICON.up + esc(gap) + '</span>' : '');
    const bar = el.querySelector('.rk-bar i');
    requestAnimationFrame(() => { bar.style.width = Math.max(a.confirmed ? 6 : 0, a.confirmed / max * 100) + '%'; });
  }
}

/** Puts children in the given order, moving only the ones that are out of place. */
function placeInOrder(container, els) {
  els.forEach((el, i) => {
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
  });
}

function renderArrivals(slots) {
  const box = $('arrivalChart');
  const list = $('arrivalList');
  if (!box || !list) return;
  const rows = (slots || []).filter((slot) => slot.records > 0);
  box.hidden = !canSeeBoard() || !rows.length;
  if (!rows.length) { list.innerHTML = ''; return; }
  const max = Math.max(1, ...rows.map((slot) => slot.expectedAttendees || 0));
  list.innerHTML = rows.map((slot) => {
    const people = slot.expectedAttendees || 0;
    const width = Math.max(people ? 6 : 0, (people / max) * 100);
    const label = slot.expectedArrivalLabel || slot.expectedArrival;
    return '<li><span>' + esc(label) + '</span><span class="bar"><i style="width:' + width + '%"></i></span><b>' +
      people + ' guests · ' + slot.records + (slot.records === 1 ? ' RSVP' : ' RSVPs') + '</b></li>';
  }).join('');
}

function renderRanking(agentsIn) {
  const podium = $('podium');
  const list = $('ranks');
  if (!agentsIn.length) {
    podium.innerHTML = '';
    list.innerHTML = '<li class="stage-empty">No agents yet. Add them in the Agents tab, then they appear here.</li>';
    return;
  }
  const stale = list.querySelector('.stage-empty');
  if (stale) stale.remove();
  const agents = agentsIn.slice().sort(byLeader);
  const max = Math.max(1, agents[0].confirmed);
  const prev = S.prevRanks;
  const before = {};
  list.querySelectorAll('li.rk').forEach((li) => { before[li.dataset.id] = li.getBoundingClientRect().top; });
  const old = {};
  podium.querySelectorAll('.pod').forEach((el) => { old['p:' + el.dataset.id] = el; });
  list.querySelectorAll('li.rk').forEach((el) => { old['l:' + el.dataset.id] = el; });

  const pods = [];
  const rows = [];
  const next = {};
  agents.forEach((a, i) => {
    const rank = i + 1;
    const onPodium = rank <= 3;
    const key = (onPodium ? 'p:' : 'l:') + a.id;
    let el = old[key];
    if (!el) {
      el = onPodium ? makePod() : makeRow();
      el.dataset.id = a.id;
      el.classList.add('enter');
      el.style.setProperty('--i', onPodium ? [1, 0, 2][i] : i);
    }
    delete old[key];
    fillCard(el, a, rank, tierFor(a, agents), gapLine(agents, i), onPodium, max);
    const was = prev && prev[a.id];
    if (was && a.confirmed > was.confirmed) bumpCard(el, a.confirmed - was.confirmed);
    if (was && rank < was.rank) upChip(el, was.rank - rank);
    next[a.id] = { rank, confirmed: a.confirmed };
    (onPodium ? pods : rows).push(el);
  });
  Object.keys(old).forEach((k) => old[k].remove());
  placeInOrder(podium, pods);
  placeInOrder(list, rows);

  if (prev && !reducedMotion) {
    rows.forEach((li) => {
      const top0 = before[li.dataset.id];
      if (top0 == null) return;
      const dy = top0 - li.getBoundingClientRect().top;
      if (Math.abs(dy) > 2) li.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: 700, easing: 'cubic-bezier(.2,.8,.2,1)' });
    });
  }
  const leader = agents[0];
  if (prev && S.leaderId && S.leaderId !== leader.id && leader.confirmed > 0) celebrate(leader);
  S.leaderId = leader.id;
  S.prevRanks = next;
}

function bumpCard(el, n) {
  if (reducedMotion) return;
  const num = el.querySelector('.pod-num b, .rk-num b');
  num.classList.remove('bump');
  void num.offsetWidth;
  num.classList.add('bump');
  const plus = document.createElement('span');
  plus.className = 'plus';
  plus.textContent = '+' + n;
  el.appendChild(plus);
  setTimeout(() => plus.remove(), 1700);
  el.classList.add('glow');
  setTimeout(() => el.classList.remove('glow'), 1500);
  if (S.view === 'board') {
    const r = el.getBoundingClientRect();
    confetti(26, r.right - 40, r.top + 24);
    Sand.ripple();
  }
}

function upChip(el, n) {
  const chip = document.createElement('span');
  chip.className = 'up-chip';
  chip.innerHTML = ICON.up + 'Up ' + n;
  el.appendChild(chip);
  setTimeout(() => chip.remove(), 4200);
}

function celebrate(a) {
  if (S.view !== 'board' || !canSeeBoard()) return;
  const box = $('celebrate');
  $('celebrateAv').innerHTML = avatar(a.name, 'av-hero');
  $('celebrateName').textContent = a.name;
  $('celebrateSub').textContent = 'takes the lead with ' + plural(a.confirmed, 'confirmed guest', 'confirmed guests');
  box.hidden = false;
  box.classList.remove('out');
  confetti(170, innerWidth / 2, innerHeight * 0.3);
  Sand.crown();
  clearTimeout(celebrate.t1);
  clearTimeout(celebrate.t2);
  celebrate.t1 = setTimeout(() => box.classList.add('out'), 3800);
  celebrate.t2 = setTimeout(() => { box.hidden = true; box.classList.remove('out'); }, 4400);
}

/* ---------- motivation ticker ---------- */

function renderTicker(agentsIn, t) {
  const agents = agentsIn.slice().sort(byLeader);
  const items = [];
  const lead = agents[0];
  if (lead && lead.confirmed > 0) items.push([ICON.crown, '<b>' + esc(lead.name) + '</b> leads with ' + plural(lead.confirmed, 'confirmed guest', 'confirmed guests')]);
  for (let i = 1; i < agents.length && items.length < 4; i++) {
    const a = agents[i];
    const b = agents[i - 1];
    if (b.confirmed > 0 && b.confirmed - a.confirmed <= 1) {
      items.push([ICON.bolt, '<b>' + esc(firstName(a.name)) + '</b> is ' + plural(b.confirmed - a.confirmed + 1, 'guest', 'guests') + ' away from passing <b>' + esc(firstName(b.name)) + '</b>']);
    }
  }
  agents.filter((a) => a.today > 0).sort((x, y) => y.today - x.today).slice(0, 3)
    .forEach((a) => items.push([ICON.flame, '<b>' + esc(firstName(a.name)) + '</b> added ' + plural(a.today, 'RSVP', 'RSVPs') + ' today']));
  items.push([ICON.people, 'Team total: <b>' + plural(t.confirmed, 'confirmed guest', 'confirmed guests') + '</b> from ' + plural(t.parties, 'RSVP', 'RSVPs')]);
  const win = S.event && eventWindow(S.event);
  if (win && now() < win.start) {
    const days = Math.ceil((win.start - now()) / 86400000);
    items.push([ICON.clock, '<b>' + plural(days, 'day', 'days') + '</b> to opening. Every RSVP counts']);
  }
  items.push([ICON.star, 'The top 25% wear Elite mint. Who takes the crown?']);
  items.push([ICON.up, 'One confirmed guest can move you up the ranking']);
  const html = items.map((it) => '<span class="ticker-item">' + it[0] + '<span>' + it[1] + '</span></span><i class="ticker-dot"></i>').join('');
  const track = $('tickerTrack');
  if (track.dataset.sig !== html) {
    track.dataset.sig = html;
    track.innerHTML = '<span class="ticker-run">' + html + '</span><span class="ticker-run" aria-hidden="true">' + html + '</span>';
    track.style.setProperty('--dur', Math.max(30, Math.round(track.textContent.length / 2 / 5)) + 's');
  }
}

/* ---------- Latest: floating cards ---------- */

const ST_CLASS = { Confirmed: 'st-confirmed', Maybe: 'st-maybe', Awaiting: 'st-awaiting', Declined: 'st-declined' };

function feedLine(f) {
  const g = f.guest ? '<b>' + esc(f.guest) + '</b>' : 'a guest';
  const n = f.party > 1 ? ' &middot; ' + f.party + ' people' : '';
  const tag = (cls, text) => ' <span class="tag ' + cls + '">' + esc(text) + '</span>';
  if (f.action === 'checked in') return g + ' arrived' + n + tag('st-arrived', 'Arrived');
  if (f.action === 'status') return g + ' is now' + tag(ST_CLASS[f.status] || '', f.status);
  const verb = { Confirmed: 'confirmed', Maybe: 'added', Awaiting: 'invited', Declined: 'logged' }[f.status] || 'added';
  return '<b>' + esc(f.who) + '</b> ' + verb + ' ' + g + n + tag(ST_CLASS[f.status] || '', f.status);
}

function renderFeed(feed) {
  const ul = $('feed');
  if (!feed.length) {
    ul.innerHTML = '<li class="stage-empty">RSVPs appear here the moment an agent saves them.</li>';
    S.feedKeys = new Set();
    return;
  }
  const keys = feed.map((f) => f.t + '|' + f.action + '|' + f.guest);
  ul.innerHTML = feed.map((f, i) => {
    const fresh = S.feedKeys && !S.feedKeys.has(keys[i]);
    return '<li class="' + (fresh ? 'new' : '') + '" style="--i:' + i + '">' + avatar(f.who, 'av-sm') +
      '<p>' + feedLine(f) + '</p><time data-t="' + f.t + '">' + ago(f.t) + '</time></li>';
  }).join('');
  S.feedKeys = new Set(keys);
}

/* ---------- digital countdown ---------- */

function setDigits(id, n) {
  const el = $(id);
  const txt = String(n).padStart(2, '0');
  if (el.textContent === txt) return;
  el.textContent = txt;
  el.previousElementSibling.textContent = '8'.repeat(txt.length);
}

function renderCountdown(ev) {
  const cd = $('countdown');
  const win = eventWindow(ev);
  if (!win) { cd.hidden = true; return; }
  cd.hidden = false;
  const t = now();
  let state, label, target;
  if (t < win.start) { state = 'before'; label = ev.daily ? 'Opens in' : 'Starts in'; target = win.start; }
  else if (t < win.end) { state = 'open'; label = ev.daily ? 'Open now · closes in' : 'Happening now · ends in'; target = win.end; }
  else if (ev.daily) { state = 'closed'; label = 'Closed · opens in'; target = win.start + 86400000; }
  else { state = 'ended'; label = 'This open house has ended'; }
  const cls = 'cd is-' + state;
  if (cd.className !== cls) cd.className = cls;
  $('cdLabel').textContent = label;
  $('cdRow').hidden = state === 'ended';
  if (state === 'ended') return;
  const s = Math.max(0, Math.floor((target - t) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  setDigits('cdD', d);
  setDigits('cdH', h);
  setDigits('cdM', m);
  setDigits('cdS', s % 60);
  cd.setAttribute('aria-label', label + ' ' + d + ' days, ' + h + ' hours, ' + m + ' minutes');
}

/* ---------- once a second: countdown, "updated" line, feed times ---------- */

function tick() {
  const ev = S.event;
  if (!ev) return;
  if (ev.daily && S.shownDay !== todayDubai()) renderEventText();   // midnight in Dubai: show the new day
  renderCountdown(ev);
  const since = S.lastOk ? Math.round((Date.now() - S.lastOk) / 1000) : null;
  $('updated').textContent = since == null ? 'Connecting' :
    (S.failures ? 'Reconnecting · last update ' : 'Live · updated ') + (since < 5 ? 'just now' : since < 90 ? since + ' s ago' : Math.round(since / 60) + ' min ago');
  if (S.board && Date.now() % 5000 < 1000) document.querySelectorAll('#feed time[data-t]').forEach((n) => { n.textContent = ago(Number(n.dataset.t)); });
}

/* ---------- confetti (mint, cyan, amber, white) ---------- */

const confetti = (() => {
  let canvas = null, ctx = null, parts = [], raf = 0;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const colors = ['#E3B35E', '#F7E2B0', '#C98350', '#FFFFFF'];
  function size() {
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
  }
  function step() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    parts.forEach((p) => {
      p.vy += 0.32 * dpr;
      p.vx *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      p.life++;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.globalAlpha = Math.max(0, 1 - p.life / 150);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    });
    parts = parts.filter((p) => p.life < 150 && p.y < canvas.height + 40);
    raf = parts.length ? requestAnimationFrame(step) : 0;
    if (!raf) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  return function burst(n, x, y) {
    if (reducedMotion || document.hidden) return;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'confetti';
      document.body.appendChild(canvas);
      ctx = canvas.getContext('2d');
      size();
      addEventListener('resize', size);
    }
    for (let i = 0; i < n; i++) {
      parts.push({
        x: x * dpr, y: y * dpr, vx: (Math.random() - 0.5) * 16 * dpr, vy: (-Math.random() * 13 - 5) * dpr,
        s: (5 + Math.random() * 6) * dpr, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.35, c: colors[i % colors.length], life: 0
      });
    }
    if (!raf) raf = requestAnimationFrame(step);
  };
})();
