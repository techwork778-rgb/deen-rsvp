import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { handleAction, start } from './crm-bridge.mjs';

const KEY = 'dashboard-test-key-32chars';

function sampleRows() {
  const eventA = { id: '11111111-1111-4111-8111-111111111111', eventName: 'Marina Open House', eventDate: '2026-11-20T00:00:00.000Z', startTime: '16:00', endTime: '21:00', venueName: 'Address Beach', location: 'Dubai Marina', developerName: 'Emaar', status: 'upcoming' };
  const eventB = { id: '22222222-2222-4222-8222-222222222222', eventName: 'Creek Open House', eventDate: '2026-12-01T00:00:00.000Z', startTime: '10:00', endTime: '18:00', venueName: 'Creek Harbour', location: 'Dubai Creek', developerName: 'Emaar', status: 'upcoming' };
  const row = (id, event, name, withGuest, status, arrival, createdByName, createdAt) => ({
    id, guestName: name, mobile: '+9715011100' + id, peopleComingWith: withGuest, party: withGuest + 1,
    expectedArrival: arrival, expectedArrivalLabel: arrival, status, statusLabel: status,
    interestedInLabel: '2 BR', budgetLabel: 'AED 2 – 3 Million', notes: '',
    createdAt, updatedAt: createdAt, createdByName, event,
  });
  return {
    events: [eventB, eventA],
    rows: [
      row('a', eventA, 'Aisha Khan', 2, 'confirmed', '18:00', 'Aisha Staff', '2026-11-09T10:00:00.000Z'),
      row('b', eventA, 'Omar Ali', 0, 'confirmed', '18:00', 'Aisha Staff', '2026-11-09T11:00:00.000Z'),
      row('c', eventB, 'Sara Noor', 1, 'maybe', '18:30', 'Bilal Staff', '2026-11-09T12:00:00.000Z'),
    ],
  };
}

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('bridge maps CRM pages into the dashboard payload', async () => {
  const { events, rows } = sampleRows();
  const seen = [];
  const crm = await listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    seen.push(req.headers.authorization || '');
    if (req.headers.authorization !== 'Bearer ' + KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const send = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.endsWith('/events')) return send({ data: events, meta: { total: events.length, page: 1, pageSize: 100, totalPages: 1 } });
    if (url.pathname.endsWith('/stats')) {
      return send({ data: {
        records: { total: 3, confirmed: 2, maybe: 1, awaiting: 0, declined: 0 },
        attendees: { confirmed: 5, maybe: 2, totalExpected: 5 },
        today: { date: '2026-11-09', newRsvps: 3, confirmedAttendees: 5 },
        byEvent: events.map((event) => ({ event, records: { total: 0 }, attendees: { totalExpected: 0 } })),
        byArrival: [
          { expectedArrival: '18:00', expectedArrivalLabel: '6:00 PM', records: 2, confirmedRecords: 2, expectedAttendees: 5 },
          { expectedArrival: '18:30', expectedArrivalLabel: '6:30 PM', records: 1, confirmedRecords: 0, expectedAttendees: 0 },
        ],
        byCreator: [
          { createdByName: 'Aisha Staff', records: { total: 2, confirmed: 2, maybe: 0, awaiting: 0, declined: 0 }, expectedAttendees: 5, todayNew: 2 },
          { createdByName: 'Bilal Staff', records: { total: 1, confirmed: 0, maybe: 1, awaiting: 0, declined: 0 }, expectedAttendees: 0, todayNew: 1 },
        ],
      } });
    }
    if (url.pathname.endsWith('/rsvps')) {
      const page = Number(url.searchParams.get('page') || 1);
      const chunk = page === 1 ? rows.slice(0, 2) : rows.slice(2);
      return send({ data: chunk, meta: { total: rows.length, page, pageSize: 100, totalPages: 2 } });
    }
    res.writeHead(404);
    res.end();
  });

  process.env.CRM_API_BASE_URL = 'http://127.0.0.1:' + crm.address().port;
  process.env.RSVP_DASHBOARD_API_KEY = KEY;
  process.env.DASHBOARD_ADMIN_PIN = '482913';
  delete process.env.DASHBOARD_BOARD_KEY;

  const pub = await handleAction({ action: 'sync', payload: {} });
  assert.equal(pub.ok, true);
  assert.equal(pub.data.event.name, 'Creek Open House');
  assert.equal(pub.data.board.totals.confirmed, 5);
  assert.equal(pub.data.board.totals.confirmedParties, 2);
  assert.equal(pub.data.board.totals.parties, 3);
  assert.equal(pub.data.board.totals.maybe, 2);
  assert.equal(pub.data.board.arrivals[0].expectedAttendees, 5);
  assert.equal(pub.data.board.feed[0].guest, 'Sara N.');
  assert.equal(pub.data.mine, undefined);
  assert.equal(JSON.stringify(pub.data.board).includes('+971'), false);
  assert.equal(JSON.stringify(pub.data.board).includes('Aisha Khan'), false);

  const denied = await handleAction({ action: 'login', payload: { auth: { id: 'agent', pin: '1' } } });
  assert.equal(denied.ok, false);

  const signed = await handleAction({ action: 'login', payload: { auth: { id: 'admin', pin: '482913' } } });
  assert.equal(signed.ok, true);
  assert.equal(signed.data.mine.rsvps.length, 3);
  assert.equal(signed.data.mine.rsvps.find((row) => row.name === 'Aisha Khan').party, 3);
  assert.equal(signed.data.mine.rsvps.find((row) => row.name === 'Omar Ali').party, 1);
  assert.equal(signed.data.mine.who.role, 'admin');
  assert.deepEqual(seen.every((header) => header === 'Bearer ' + KEY), true);

  const write = await handleAction({ action: 'saveRsvp', payload: { rsvp: { name: 'Nope' } } });
  assert.equal(write.ok, false);
  assert.match(write.error, /DEEN CRM/);

  const bridge = await start(0);
  const port = bridge.address().port;
  const viaHttp = await fetch('http://127.0.0.1:' + port + '/__exec', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'sync', payload: { boardV: pub.data.board.v } }),
  });
  const again = await viaHttp.json();
  assert.equal(again.ok, true);
  assert.equal(again.data.board.same, true);

  bridge.close();
  crm.close();
});
