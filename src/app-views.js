/* Views: sign-in, the agent's own guests (every guest for the CEO), RSVP form, agents, event. */

const nameKey = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

/* ---------- sign in / out ---------- */

/** The sign-in sheet. The CEO link (?ceo) opens it with CEO already picked, ready for the PIN. */
function openSignIn(asCeo) {
  S.pick = asCeo === true ? { id: 'admin' } : null;
  renderNames();
  $('fPin').value = '';
  $('pinField').hidden = !S.pick;
  $('pinLabel').textContent = 'CEO PIN';
  $('fPin').setAttribute('inputmode', 'numeric');
  $('fPin').setAttribute('maxlength', '8');
  $('fKeep').checked = true;
  showErr('signinErr', '');
  updateGo();
  openSheet('sheet-signin');
  if (S.pick) setTimeout(() => $('fPin').focus(), 60);
}

function renderNames() {
  const names = S.agentNames.slice().sort((a, b) => a.localeCompare(b));
  const on = (id) => (S.pick && S.pick.id === id ? ' on' : '');
  let html = names.map((n) => '<button type="button" class="name-btn' + on(n) + '" role="radio" aria-checked="' + !!on(n) +
    '" data-id="' + esc(n) + '">' + esc(n) + '</button>').join('');
  if (!names.length) html = '<p class="names-empty">No agents are on the list yet. The CEO adds them first.</p>';
  html += '<button type="button" class="name-btn mgr' + on('admin') + '" role="radio" aria-checked="' + !!on('admin') + '" data-id="admin">CEO</button>';
  $('nameList').innerHTML = html;
}

function updateGo() {
  const len = $('fPin').value.trim().length;
  $('signinGo').disabled = !(S.pick && len >= (S.pick.id === 'admin' ? 4 : 1));
}

$('nameList').addEventListener('click', (e) => {
  const b = e.target.closest('.name-btn');
  if (!b) return;
  const admin = b.dataset.id === 'admin';
  S.pick = { id: b.dataset.id };
  renderNames();
  $('pinField').hidden = false;
  $('pinLabel').textContent = admin ? 'CEO PIN' : 'Your ID';
  $('fPin').setAttribute('inputmode', admin ? 'numeric' : 'text');
  $('fPin').setAttribute('maxlength', admin ? '8' : '30');
  showErr('signinErr', '');
  $('fPin').value = '';
  $('fPin').focus();
  updateGo();
});

$('fPin').addEventListener('input', () => {
  if (S.pick && S.pick.id === 'admin') $('fPin').value = $('fPin').value.replace(/\D/g, '');
  updateGo();
});

$('signinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('signinGo').disabled) return;
  const auth = { id: S.pick.id, pin: $('fPin').value.trim() };
  busy($('signinGo'), true, 'Checking');
  try {
    const res = await call('login', { auth });
    S.auth = auth;
    store.set(AUTH_KEY, auth, $('fKeep').checked);
    S.epoch++;
    applyPublic(res);
    applyBoard(res.board);
    applyMine(res.mine);
    closeSheet('sheet-signin');
    setView(isAdmin() ? homeView() : 'mine');
    toast('Signed in as <b>' + esc(res.mine.who.name) + '</b>');
    loadPhotos();
  } catch (err) {
    showErr('signinErr', err.message);
    $('fPin').select();
  } finally {
    busy($('signinGo'), false);
    updateGo();
  }
});

function signOut(msg) {
  S.auth = null;
  S.mine = null;
  S.mineV = '';
  if (!S.boardKey || S.boardKeyBad) {
    S.board = null;
    S.boardV = '';
    S.photos = {};
    S.photosV = '';
    S.prevRanks = null;
  }
  S.filter = 'all';
  S.agentFilter = '';
  S.eventFilter = '';
  S.query = '';
  $('search').value = '';
  store.del(AUTH_KEY);
  if (document.body.classList.contains('tv')) setTv(false);
  applyAuthUi();
  setView('board');
  if (msg) toast(esc(msg), 5000);
}

$('signInBtn').addEventListener('click', () => openSignIn(S.ceoLink));
$('welcomeSignIn').addEventListener('click', () => openSignIn(S.ceoLink));
$('signOutBtn').addEventListener('click', () => signOut('Signed out.'));

function applyAuthUi() {
  const who = S.mine && S.mine.who;
  const admin = isAdmin();
  $('signInBtn').hidden = !!who;
  $('me').hidden = !who;
  $('meName').textContent = who ? who.name : '';
  // Agents get two tabs (Dashboard + My RSVPs); the CEO gets all four.
  $('tabs').hidden = !(admin || (!!who && canSeeBoard()));
  document.querySelectorAll('#tabs [data-admin]').forEach((b) => { b.hidden = !admin; });
  $('tabMine').textContent = admin ? 'All guests' : 'My RSVPs';
  $('welcome').hidden = !!who || canSeeBoard();
  $('welcomeText').textContent = S.boardKeyBad && !who
    ? 'This dashboard link has been replaced. Ask the CEO for the new one. Agents can still sign in below.'
    : S.ceoLink
      ? 'CEO: sign in with your CEO PIN to see the dashboard, every guest, the agents and the event settings.'
      : 'Agents: sign in with your name and the ID the CEO gave you, then add every guest you invite.';
  $('boardBody').hidden = !canSeeBoard();
}

/* ---------- views ---------- */

/** Where a link lands: the CEO link and the dashboard link open the dashboard; the agent link opens My RSVPs (or sign-in). */
function homeView() {
  if ((S.boardKey || (S.ceoLink && isAdmin())) && canSeeBoard()) return 'board';
  return S.mine && S.mine.who ? 'mine' : 'board';
}

function setView(v) {
  const who = S.mine && S.mine.who;
  if (!who) v = 'board';
  else if (who.role !== 'admin') v = v === 'board' && canSeeBoard() ? 'board' : 'mine';
  const changed = S.view !== v;
  S.view = v;
  applyAuthUi();
  ['board', 'mine', 'agents', 'event'].forEach((k) => { $('view-' + k).hidden = k !== v; });
  document.querySelectorAll('#tabs button').forEach((b) => { b.classList.toggle('on', b.dataset.view === v); });
  if (v === 'board' && S.board && S.event) renderBoard();
  if (v === 'mine') renderMine();
  if (v === 'agents') renderAgents();
  if (v === 'event') fillEvent(true);
  if (changed) window.scrollTo(0, 0);
}

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) setView(b.dataset.view);
});

function applyMine(m) {
  if (!m || m.same) return;
  const before = S.mine ? new Map(S.mine.rsvps.map((r) => [r.id, r.updated + '|' + r.checkedIn])) : null;
  const firstTime = !S.mine;
  S.mine = m;
  S.mineV = m.v;
  if (firstTime) setView(homeView());
  else applyAuthUi();
  const changed = before ? m.rsvps.filter((r) => before.get(r.id) !== r.updated + '|' + r.checkedIn).map((r) => r.id) : [];
  if (S.view === 'mine') renderMine(changed);
  if (S.view === 'agents') renderAgents();
  if (S.view === 'event') fillEvent(false);
}

/* ---------- my RSVPs / all guests ---------- */

function renderMine(flash) {
  const m = S.mine;
  if (!m) return;
  const admin = m.who.role === 'admin';
  $('mineTitle').textContent = admin ? 'All guests' : 'My RSVPs';
  $('mineEyebrow').textContent = admin ? 'CEO' : 'Signed in as ' + m.who.name;
  $('mineAvatar').innerHTML = admin ? '' : avatar(m.who.name);
  $('closedNote').hidden = m.open;
  $('closedNote').textContent = admin
    ? 'RSVPs are closed for agents. You can still add and edit. Reopen them in Event.'
    : 'RSVPs are closed by the CEO. You can still check guests in when they arrive.';
  $('addBtn').disabled = !m.open && !admin;

  const eventFilter = $('eventFilter');
  if (eventFilter) {
    const events = [];
    m.rsvps.forEach((r) => {
      if (r.eventId && !events.some((item) => item.id === r.eventId)) events.push({ id: r.eventId, name: r.eventName || 'Open house' });
    });
    events.sort((a, b) => a.name.localeCompare(b.name));
    eventFilter.hidden = !admin || events.length < 2;
    const eventOpts = '<option value="">All events</option>' + events.map((item) => '<option value="' + esc(item.id) + '">' + esc(item.name) + '</option>').join('');
    if (eventFilter.dataset.opts !== eventOpts) { eventFilter.innerHTML = eventOpts; eventFilter.dataset.opts = eventOpts; }
    if (S.eventFilter && !events.some((item) => item.id === S.eventFilter)) S.eventFilter = '';
    eventFilter.value = S.eventFilter;
  }

  const agentFilter = $('agentFilter');
  agentFilter.hidden = !admin;
  if (admin) {
    const names = (m.agents || []).map((a) => a.name);
    m.rsvps.forEach((r) => { if (r.agent && !names.some((n) => nameKey(n) === nameKey(r.agent))) names.push(r.agent); });
    const opts = '<option value="">All agents</option>' + names.sort((a, b) => a.localeCompare(b))
      .map((n) => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
    if (agentFilter.dataset.opts !== opts) { agentFilter.innerHTML = opts; agentFilter.dataset.opts = opts; }
    agentFilter.value = S.agentFilter;
  }

  const scoped = m.rsvps.filter((r) => (!S.eventFilter || r.eventId === S.eventFilter) && (!S.agentFilter || nameKey(r.agent) === nameKey(S.agentFilter)));
  const sumParty = (rows) => rows.reduce((n, r) => n + r.party, 0);
  $('myStats').innerHTML =
    '<div><dt>Confirmed guests</dt><dd>' + sumParty(scoped.filter((r) => r.status === 'Confirmed')) + '</dd></div>' +
    '<div><dt>RSVPs</dt><dd>' + scoped.length + '</dd></div>' +
    '<div><dt>Awaiting reply</dt><dd>' + scoped.filter((r) => r.status === 'Awaiting').length + '</dd></div>' +
    '<div><dt>Arrived</dt><dd>' + sumParty(scoped.filter((r) => r.checkedIn)) + '<small>people</small></dd></div>';

  const counts = { all: scoped.length, Arrived: scoped.filter((r) => r.checkedIn).length };
  STATUSES.forEach((s) => { counts[s] = scoped.filter((r) => r.status === s).length; });
  $('chips').innerHTML = ['all'].concat(STATUSES, ['Arrived']).map((f) => '<button type="button" class="chip' + (S.filter === f ? ' on' : '') +
    '" data-f="' + f + '" aria-pressed="' + (S.filter === f) + '">' + (f === 'all' ? 'All' : f) + ' <b>' + counts[f] + '</b></button>').join('');

  const q = S.query.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const rows = scoped.filter((r) => {
    if (S.filter === 'Arrived' ? !r.checkedIn : S.filter !== 'all' && r.status !== S.filter) return false;
    if (!q) return true;
    return (r.name + ' ' + r.notes + ' ' + r.agent + ' ' + r.interest).toLowerCase().indexOf(q) >= 0 ||
      (qDigits.length >= 3 && r.mobile.replace(/\D/g, '').indexOf(qDigits) >= 0);
  }).sort((a, b) => b.created - a.created);

  const flashSet = new Set(flash || []);
  $('list').innerHTML = rows.map((r) => rowHtml(r, admin, flashSet.has(r.id))).join('');

  const empty = $('listEmpty');
  if (rows.length) empty.hidden = true;
  else {
    empty.hidden = false;
    empty.innerHTML = scoped.length
      ? '<h3>No matches</h3><p>Nothing fits this filter or search. Clear the search or pick another status.</p>'
      : admin
        ? '<h3>No RSVPs yet</h3><p>When agents add guests, every RSVP shows up here with the agent\'s name. You can also add one for any agent.</p>'
        : '<h3>No guests yet</h3><p>Add the first guest you invited. The CEO sees it on the live dashboard the moment you save.</p>' +
          (m.open ? '<button class="btn" type="button" data-add-rsvp>Add your first RSVP</button>' : '');
  }
}

function rowHtml(r, admin, flash) {
  const canEdit = admin || S.mine.open;
  const sub = ['<span class="g-mob">' + esc(fmtMobile(r.mobile)) + '</span>'];
  if (r.arrival) sub.push('<span>Arrives ' + fmt12(r.arrival) + '</span>');
  if (r.interest) sub.push('<span>' + esc(r.interest) + '</span>');
  if (r.budget) sub.push('<span>' + esc(r.budget) + '</span>');
  if (r.eventName) sub.push('<span>' + esc(r.eventName) + '</span>');
  if (admin) sub.push('<span class="g-agent">' + esc(r.agent || 'No agent') + '</span>');
  return '<li class="row' + (flash ? ' flash' : '') + '" data-id="' + esc(r.id) + '">' +
    '<div class="row-main">' +
      '<p class="g-name">' + esc(r.name) + '<span class="g-party">' + plural(r.party, 'person', 'people') + '</span></p>' +
      '<p class="g-sub">' + sub.join('') + '</p>' +
      (r.notes ? '<p class="g-notes">' + esc(r.notes) + '</p>' : '') +
    '</div>' +
    '<div class="row-side">' +
      (r.checkedIn ? '<span class="arrived"><svg aria-hidden="true"><use href="#i-checkc"/></svg>Arrived ' + fmtClock(r.checkedIn) + '</span>' : '') +
      '<span class="pill p-' + r.status.toLowerCase() + '">' + esc(r.status) + '</span>' +
      '<span class="row-act">' +
        '<a class="icon-btn" href="' + esc(waLink(r)) + '" target="_blank" rel="noopener" title="WhatsApp ' + esc(firstName(r.name)) + '" aria-label="Send WhatsApp to ' + esc(r.name) + '"><svg aria-hidden="true"><use href="#i-chat"/></svg></a>' +
        '<button type="button" class="icon-btn' + (r.checkedIn ? ' on' : '') + '" data-act="checkin" aria-pressed="' + !!r.checkedIn + '" title="' + (r.checkedIn ? 'Undo check-in' : 'Check in on arrival') + '" aria-label="' + (r.checkedIn ? 'Undo check-in for ' : 'Check in ') + esc(r.name) + '"><svg aria-hidden="true"><use href="#i-check"/></svg></button>' +
        '<button type="button" class="icon-btn" data-act="edit"' + (canEdit ? '' : ' disabled') + ' title="Edit" aria-label="Edit ' + esc(r.name) + '"><svg aria-hidden="true"><use href="#i-edit"/></svg></button>' +
      '</span>' +
    '</div></li>';
}

/** Pre-written WhatsApp message to the guest, sent from the agent's own phone. */
function waLink(r) {
  const ev = S.event || { name: 'Open House', start: '09:00', end: '22:00' };
  const agent = r.agent || (S.mine ? S.mine.who.name : '');
  const hours = fmt12(ev.start) + ' to ' + fmt12(ev.end);
  const where = ev.venue ? ' at ' + ev.venue : '';
  const startsLater = ev.daily && ev.date && ev.date > todayDubai();
  const when = ev.daily
    ? (startsLater ? ' from ' + fmtShortDate(ev.date) + ', open every day ' : ', open every day ') + hours
    : ev.date ? ' on ' + fmtShortDate(ev.date) + ', ' + hours : '';
  const arrive = r.arrival ? ' We will expect you at ' + fmt12(r.arrival) + '.' : '';
  const hi = 'Hi ' + firstName(r.name) + ', this is ' + firstName(agent) + ' from DEEN Properties. ';
  let text;
  if (r.status === 'Confirmed') {
    text = hi + 'You are confirmed for the ' + ev.name + where + when + '.' + arrive +
      (r.party > 1 ? ' We look forward to welcoming all ' + r.party + ' of you.' : '') + ' See you there!';
  } else if (r.status === 'Declined') {
    text = hi + 'Sorry you can\'t make it to the ' + ev.name + '. I am happy to arrange a private viewing whenever it suits you.';
  } else {
    text = hi + 'You are invited to the ' + ev.name + where + when + '. Can you join us? Reply with the day and time that suit you and how many people are coming.';
  }
  return 'https://wa.me/' + String(r.mobile).replace(/\D/g, '') + '?text=' + encodeURIComponent(text);
}

$('chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  S.filter = b.dataset.f;
  renderMine();
});
$('agentFilter').addEventListener('change', () => { S.agentFilter = $('agentFilter').value; renderMine(); });
$('eventFilter').addEventListener('change', () => { S.eventFilter = $('eventFilter').value; renderMine(); });
$('search').addEventListener('input', () => { S.query = $('search').value; renderMine(); });
$('addBtn').addEventListener('click', () => openRsvp(null));
$('listEmpty').addEventListener('click', (e) => { if (e.target.closest('[data-add-rsvp]')) openRsvp(null); });

$('list').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || b.disabled) return;
  const r = S.mine.rsvps.find((x) => x.id === b.closest('.row').dataset.id);
  if (!r) return;
  if (b.dataset.act === 'edit') { openRsvp(r); return; }
  b.disabled = true;
  try {
    await write('checkIn', { id: r.id, arrived: !r.checkedIn });
    toast(r.checkedIn ? 'Check-in undone for <b>' + esc(r.name) + '</b>.' : '<b>' + esc(r.name) + '</b> checked in' + (r.party > 1 ? ' with ' + (r.party - 1) + ' more' : '') + '.');
  } catch (err) {
    toast(esc(err.message), 6000);
    b.disabled = false;
  }
});

/* ---------- add / edit RSVP ---------- */

function fillSelect(id, values, current, emptyLabel) {
  const list = values.slice();
  if (current && list.indexOf(current) < 0) list.push(current);
  $(id).innerHTML = '<option value="">' + esc(emptyLabel) + '</option>' +
    list.map((v) => '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
}

function arrivalSlots() {
  const ev = S.event || { start: '18:00', end: '21:00' };
  const toMin = (s) => { const p = s.split(':').map(Number); return p[0] * 60 + p[1]; };
  const start = toMin(ev.start);
  let end = toMin(ev.end);
  if (end <= start) end += 24 * 60;
  const out = [];
  for (let t = start; t < end && out.length < 48; t += 30) {
    const m = t % (24 * 60);
    out.push(String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));
  }
  return out;
}

function setParty(n) {
  S.party = Math.max(1, Math.min(20, n));
  $('fParty').textContent = S.party;
  $('pMinus').disabled = S.party <= 1;
  $('pPlus').disabled = S.party >= 20;
}
$('pMinus').addEventListener('click', () => setParty(S.party - 1));
$('pPlus').addEventListener('click', () => setParty(S.party + 1));

function openRsvp(r) {
  const m = S.mine;
  const admin = m.who.role === 'admin';
  S.editing = r ? r.id : null;
  $('rsvpTitle').textContent = r ? 'Edit RSVP' : 'Add RSVP';
  $('agentField').hidden = !admin;
  if (admin) {
    const names = (m.agents || []).map((a) => a.name).sort((a, b) => a.localeCompare(b));
    $('fAgent').innerHTML = '<option value="">Choose agent</option>' + names.map((n) => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
    const current = r ? names.find((n) => nameKey(n) === nameKey(r.agent)) : names.find((n) => nameKey(n) === nameKey(S.agentFilter));
    $('fAgent').value = current || '';
  }
  $('fName').value = r ? r.name : '';
  $('fMobile').value = r ? fmtMobile(r.mobile) : '';
  setParty(r ? r.party : 1);
  const status = r ? r.status : 'Confirmed';
  document.querySelectorAll('#fStatus input').forEach((i) => { i.checked = i.value === status; });
  const slots = arrivalSlots();
  const cur = r ? r.arrival : '';
  if (cur && slots.indexOf(cur) < 0) slots.push(cur);
  $('fArrival').innerHTML = '<option value="">Not sure</option>' + slots.map((s) => '<option value="' + s + '"' + (s === cur ? ' selected' : '') + '>' + fmt12(s) + '</option>').join('');
  fillSelect('fInterest', INTERESTS, r ? r.interest : '', 'Not specified');
  fillSelect('fBudget', BUDGETS, r ? r.budget : '', 'Not specified');
  $('fNotes').value = r ? r.notes : '';
  $('moreBox').open = !!(r && (r.interest || r.budget || r.notes));
  $('rsvpDelete').hidden = !r;
  $('delConfirm').hidden = true;
  showErr('rsvpErr', '');
  openSheet('sheet-rsvp');
}

$('rsvpForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const checked = document.querySelector('#fStatus input:checked');
  const rsvp = {
    id: S.editing || '', agentName: $('fAgent').value, name: $('fName').value.trim(), mobile: $('fMobile').value.trim(),
    party: S.party, status: checked ? checked.value : '', arrival: $('fArrival').value,
    interest: $('fInterest').value, budget: $('fBudget').value, notes: $('fNotes').value.trim()
  };
  if (isAdmin() && !rsvp.agentName && !S.editing) return showErr('rsvpErr', 'Choose the agent this guest belongs to.');
  if (rsvp.name.length < 2) { $('fName').focus(); return showErr('rsvpErr', 'Add the guest\'s name.'); }
  if (rsvp.mobile.replace(/\D/g, '').length < 7) { $('fMobile').focus(); return showErr('rsvpErr', 'Add the guest\'s mobile number, e.g. 050 123 4567.'); }
  showErr('rsvpErr', '');
  busy($('rsvpSave'), true);
  try {
    const wasNew = !S.editing;
    const res = await write('saveRsvp', { rsvp });
    closeSheet('sheet-rsvp');
    const digits = rsvp.mobile.replace(/\D/g, '').slice(-9);
    const saved = res.mine.rsvps.find((x) => x.mobile.replace(/\D/g, '').slice(-9) === digits);
    toast('<span>' + (wasNew ? 'Added' : 'Saved') + ' <b>' + esc(rsvp.name) + '</b>.</span>' +
      (saved ? '<a href="' + esc(waLink(saved)) + '" target="_blank" rel="noopener">WhatsApp them</a>' : ''), 8000);
  } catch (err) {
    showErr('rsvpErr', err.message);
  } finally {
    busy($('rsvpSave'), false);
  }
});

$('rsvpDelete').addEventListener('click', () => { $('rsvpDelete').hidden = true; $('delConfirm').hidden = false; });
$('delNo').addEventListener('click', () => { $('rsvpDelete').hidden = false; $('delConfirm').hidden = true; });
$('delYes').addEventListener('click', async () => {
  const r = S.mine.rsvps.find((x) => x.id === S.editing);
  busy($('delYes'), true, 'Removing');
  try {
    await write('deleteRsvp', { id: S.editing });
    closeSheet('sheet-rsvp');
    toast('Removed <b>' + esc(r ? r.name : 'the guest') + '</b>.');
  } catch (err) {
    showErr('rsvpErr', err.message);
  } finally {
    busy($('delYes'), false);
  }
});

/* ---------- CEO: agents ---------- */

function renderAgents() {
  const m = S.mine;
  if (!m || !m.agents) return;
  const stats = {};
  m.rsvps.forEach((r) => {
    const s = stats[nameKey(r.agent)] || (stats[nameKey(r.agent)] = { parties: 0, confirmed: 0 });
    s.parties++;
    if (r.status === 'Confirmed') s.confirmed += r.party;
  });
  const agents = m.agents.slice().sort((a, b) => a.name.localeCompare(b.name));
  $('agentsEmpty').hidden = agents.length > 0;
  $('agentList').innerHTML = agents.map((a) => {
    const s = stats[nameKey(a.name)] || { parties: 0, confirmed: 0 };
    const id = a.code
      ? '<span>ID <b class="g-mob" data-code="' + esc(a.code) + '">' + '&bull;'.repeat(Math.min(a.code.length, 8)) + '</b></span>'
      : '<span><b>No ID yet.</b> Add one so they can sign in.</span>';
    return '<li class="row" data-name="' + esc(a.name) + '">' +
      '<div class="row-main row-who">' + avatar(a.name) + '<div><p class="g-name">' + esc(a.name) + '<span class="g-party">' + plural(s.confirmed, 'confirmed guest', 'confirmed guests') + ' &middot; ' + plural(s.parties, 'RSVP', 'RSVPs') + '</span></p>' +
      '<p class="g-sub">' + id + '</p></div></div>' +
      '<div class="row-side"><span class="row-act">' +
      (a.code ? '<button type="button" class="icon-btn" data-act="show" title="Show ID" aria-label="Show the ID of ' + esc(a.name) + '"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg></button>' : '') +
      '<button type="button" class="icon-btn" data-act="edit" title="Edit agent" aria-label="Edit ' + esc(a.name) + '"><svg aria-hidden="true"><use href="#i-edit"/></svg></button></span></div></li>';
  }).join('');
}

$('agentList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const row = b.closest('.row');
  const a = S.mine.agents.find((x) => x.name === row.dataset.name);
  if (!a) return;
  if (b.dataset.act === 'edit') openAgent(a);
  if (b.dataset.act === 'show') {
    const code = row.querySelector('[data-code]');
    const shown = code.textContent === a.code;
    code.textContent = shown ? '•'.repeat(Math.min(a.code.length, 8)) : a.code;
    b.title = shown ? 'Show ID' : 'Hide ID';
  }
});

function genCode() {
  const bad = /^(\d)\1{3}$|^(0123|1234|2345|3456|4567|5678|6789|9876|4321|1212|1122|2580|1004)$/;
  const used = new Set((S.mine.agents || []).map((x) => String(x.code).toLowerCase()));
  let code;
  do {
    const a = new Uint32Array(1);
    window.crypto.getRandomValues(a);
    code = String(a[0] % 10000).padStart(4, '0');
  } while (bad.test(code) || used.has(code));
  return code;
}

function openAgent(a) {
  S.editingAgent = a ? a.name : null;
  $('agentTitle').textContent = a ? 'Edit agent' : 'Add agent';
  $('aName').value = a ? a.name : '';
  $('aCode').value = a ? a.code : genCode();
  $('agentDelete').hidden = !a;
  $('agentDelConfirm').hidden = true;
  $('aPhotoField').hidden = !a;
  if (a) showPhotoPreview(a.name);
  showErr('agentErr', '');
  openSheet('sheet-agent');
}

function showPhotoPreview(name) {
  $('aPhotoPreview').innerHTML = avatar(name);
  $('aPhotoRemove').hidden = !S.photos[pkey(name)];
}

/** Square, head-weighted crop at 192px; WebP where the browser can make it, otherwise JPEG. */
function photoToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - side) / 2;
      const sy = (img.naturalHeight - side) * 0.3;   // portraits: keep the head, trim the chest
      const c = document.createElement('canvas');
      c.width = c.height = 192;
      c.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, 192, 192);
      let data = c.toDataURL('image/webp', 0.82);
      if (data.indexOf('data:image/webp') !== 0) data = c.toDataURL('image/jpeg', 0.85);
      resolve(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a photo we can read. Try a JPG or PNG.')); };
    img.src = url;
  });
}

async function savePhoto(photo) {
  const name = S.editingAgent;
  if (!name) return;
  try {
    await write('savePhoto', { name, photo });
    await loadPhotos();
    showPhotoPreview(name);
    toast(photo ? 'Photo saved for <b>' + esc(name) + '</b>.' : 'Photo removed.');
  } catch (err) {
    showErr('agentErr', err.message);
  }
}

$('aPhotoFile').addEventListener('change', async () => {
  const file = $('aPhotoFile').files[0];
  $('aPhotoFile').value = '';
  if (!file) return;
  showErr('agentErr', '');
  try {
    await savePhoto(await photoToDataUrl(file));
  } catch (err) {
    showErr('agentErr', err.message);
  }
});
$('aPhotoRemove').addEventListener('click', () => savePhoto(''));

$('addAgentBtn').addEventListener('click', () => openAgent(null));
$('agentsEmpty').addEventListener('click', (e) => { if (e.target.closest('[data-add-agent]')) openAgent(null); });
$('aGen').addEventListener('click', () => { $('aCode').value = genCode(); });

$('agentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const agent = { original: S.editingAgent || '', name: $('aName').value.trim(), code: $('aCode').value.trim() };
  if (agent.name.length < 2) { $('aName').focus(); return showErr('agentErr', 'Add the agent\'s name.'); }
  if (agent.code.replace(/\s/g, '').length < 3) { $('aCode').focus(); return showErr('agentErr', 'The ID needs at least 3 characters, e.g. 4821 or DP07.'); }
  busy($('agentSave'), true);
  try {
    const wasNew = !agent.original;
    await write('saveAgent', { agent });
    closeSheet('sheet-agent');
    toast((wasNew ? 'Added' : 'Saved') + ' <b>' + esc(agent.name) + '</b>. Send them the app link and their ID.', 7000);
  } catch (err) {
    showErr('agentErr', err.message);
  } finally {
    busy($('agentSave'), false);
  }
});

$('agentDelete').addEventListener('click', () => { $('agentDelete').hidden = true; $('agentDelConfirm').hidden = false; });
$('agentDelNo').addEventListener('click', () => { $('agentDelete').hidden = false; $('agentDelConfirm').hidden = true; });
$('agentDelYes').addEventListener('click', async () => {
  const name = S.editingAgent;
  busy($('agentDelYes'), true, 'Removing');
  try {
    await write('deleteAgent', { name });
    closeSheet('sheet-agent');
    toast('Removed <b>' + esc(name) + '</b>. Their guests stay on the list.', 6000);
  } catch (err) {
    showErr('agentErr', err.message);
  } finally {
    busy($('agentDelYes'), false);
  }
});

/* ---------- CEO: event ---------- */

function fillEvent(force) {
  const m = S.mine;
  if (!m || !m.settings || (!force && S.eventDirty)) return;
  const s = m.settings;
  $('eName').value = s.name;
  $('eTagline').value = s.tagline || '';
  $('eDaily').checked = !!s.daily;
  $('eDate').value = s.date || '';
  $('eStart').value = s.start;
  $('eEnd').value = s.end;
  $('eVenue').value = s.venue || '';
  document.querySelectorAll('input[name=eOpen]').forEach((i) => { i.checked = i.value === (s.open ? 'yes' : 'no'); });
  $('ePin').value = '';
  const base = PAGE_URL || m.appUrl;
  $('appLink').value = base || 'Deploy the web app to get its link';
  $('ceoLink').value = base ? base + '?ceo' : 'Deploy the web app to get its link';
  $('boardLink').value = base && m.boardKey ? base + '?board=' + m.boardKey : 'Deploy the web app to get its link';
  $('newBoardKey').hidden = false;
  $('boardKeyConfirm').hidden = true;
  $('sheetLink').href = m.sheetUrl || '#';
  showErr('eventErr', '');
  S.eventDirty = false;
}

$('eventForm').addEventListener('input', () => { S.eventDirty = true; $('eventSaved').textContent = ''; });
$('eventForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const open = document.querySelector('input[name=eOpen]:checked');
  const event = {
    name: $('eName').value.trim(), tagline: $('eTagline').value.trim(),
    daily: $('eDaily').checked, date: $('eDate').value,
    start: $('eStart').value, end: $('eEnd').value, venue: $('eVenue').value.trim(),
    open: !open || open.value === 'yes', adminPin: $('ePin').value.trim()
  };
  if (!event.name) { $('eName').focus(); return showErr('eventErr', 'Add the event name.'); }
  if (!event.start || !event.end) return showErr('eventErr', 'Add the opening and closing time.');
  if (event.adminPin && !/^\d{6,8}$/.test(event.adminPin)) return showErr('eventErr', 'The new CEO PIN must be 6 to 8 digits.');
  showErr('eventErr', '');
  busy($('eventSave'), true);
  try {
    S.eventDirty = false;
    await write('saveEvent', { event });
    fillEvent(true);
    $('eventSaved').textContent = 'Saved.' + (event.adminPin ? ' CEO PIN changed.' : '');
  } catch (err) {
    S.eventDirty = true;
    showErr('eventErr', err.message);
  } finally {
    busy($('eventSave'), false);
  }
});

document.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', () => {
  const input = $(btn.dataset.copy);
  const done = () => toast({ boardLink: 'Dashboard link copied.', ceoLink: 'CEO link copied. Keep it for yourself.' }[btn.dataset.copy] ||
    'Agent link copied. Paste it in the agents\' WhatsApp group.');
  try {
    navigator.clipboard.writeText(input.value).then(done, () => { input.select(); document.execCommand('copy'); done(); });
  } catch (e) {
    input.select();
    try { document.execCommand('copy'); done(); } catch (e2) { toast('Select the link and copy it.'); }
  }
}));

$('newBoardKey').addEventListener('click', () => { $('newBoardKey').hidden = true; $('boardKeyConfirm').hidden = false; });
$('boardKeyNo').addEventListener('click', () => { $('newBoardKey').hidden = false; $('boardKeyConfirm').hidden = true; });
$('boardKeyYes').addEventListener('click', async () => {
  const s = S.mine.settings;
  busy($('boardKeyYes'), true, 'Making');
  try {
    await write('saveEvent', { event: { name: s.name, tagline: s.tagline, daily: s.daily, date: s.date, start: s.start, end: s.end, venue: s.venue, open: s.open, newBoardKey: true } });
    fillEvent(true);
    toast('New dashboard link made. The old one no longer works.', 6000);
  } catch (err) {
    toast(esc(err.message), 6000);
  } finally {
    busy($('boardKeyYes'), false);
  }
});

/* ---------- start ---------- */

$('tvBtn').addEventListener('click', () => setTv(true));
document.querySelector('.brand').addEventListener('click', () => { if (document.body.classList.contains('tv')) setTv(false); });

(function boot() {
  S.auth = store.get(AUTH_KEY);
  let wantTv = false;
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    sync().then(() => {
      setView(homeView());
      if (wantTv && canSeeBoard()) setTv(true);
      if (S.ceoLink && !(S.mine && S.mine.who)) openSignIn(true);   // the CEO link asks for the PIN straight away
    });
  };
  const useParams = (p) => {
    wantTv = p.tv === '1' || p.view === 'tv';
    S.boardKey = String(p.board || '').trim();
    S.ceoLink = p.ceo !== undefined;
    applyAuthUi();
    start();
  };
  try {
    if (window.google && google.script && google.script.url) {
      google.script.url.getLocation((loc) => useParams((loc && loc.parameter) || {}));
      setTimeout(start, 1500);
    } else {
      const p = {};
      new URLSearchParams(location.search).forEach((v, k) => { p[k] = v; });
      useParams(p);
    }
  } catch (e) { start(); }
  setInterval(tick, 1000);
})();
