# DEEN Open House RSVP: API reference

This documents the live API as deployed in `apps-script/Code.gs`. For how to connect a CRM, start with [README.md](README.md).

## Calling the API

There is one URL and one method:

```
POST https://script.google.com/macros/s/AKfycbxxSuiDPEaALUZ6BN2KvW1ar9XHsG6OS95ZTi4guEIxa5UQBdlJHpYdYuIcUIz964Q/exec
Content-Type: text/plain;charset=utf-8

{ "action": "<action name>", "payload": { ... } }
```

Every answer is JSON in one of two forms:

```json
{ "ok": true, "data": { } }
{ "ok": false, "error": "A message that can be shown to the user." }
```

Three things about the transport:

- **Redirect.** The POST answers `302` with a `Location` on `script.googleusercontent.com`. Follow it with a GET to get the result. `curl -L -d ...`, Node's `fetch` and most HTTP libraries do this by default. Do not add `curl -X POST`, because it forces a POST on the redirect as well and Google answers with an error page.
- **Status codes.** Application errors, including bad sign-ins, are HTTP 200 with `"ok": false`.
- **Browsers.** Keep the `text/plain` content type if you call the API from a browser. It avoids a CORS preflight, which Apps Script does not answer.

Example, needing no sign-in:

```bash
curl -sL -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"action":"sync","payload":{}}' \
  "https://script.google.com/macros/s/AKfycbxxSuiDPEaALUZ6BN2KvW1ar9XHsG6OS95ZTi4guEIxa5UQBdlJHpYdYuIcUIz964Q/exec"
```

The same call in Node 18 or later:

```js
const res = await fetch(API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: JSON.stringify({ action: 'sync', payload: {} })
});
const answer = await res.json();
if (!answer.ok) throw new Error(answer.error);
console.log(answer.data);
```

## Signing in

There are no sessions or tokens. Every call that needs a sign-in carries an `auth` object:

| Who | `auth` | How it is checked |
|---|---|---|
| CEO | `{ "id": "admin", "pin": "<CEO PIN>" }` | Exact match, 6 to 8 digits |
| Agent | `{ "id": "<agent's full name>", "pin": "<agent's password>" }` | Name and password both ignore capitals. The password also ignores spaces |

| | CEO | Agent |
|---|---|---|
| Guests | All | Only their own |
| Add, edit, remove or check in guests | Yes, always | Own guests. Adding, editing and removing stop while RSVPs are closed. Check-in does not |
| Agents, photos, event settings | Yes | No |
| Agent passwords in answers | Yes (`mine.agents[].code`) | No |

**Lock-out.** Five wrong passwords on any action other than `sync` or `photos` lock that name for 10 minutes. `sync` and `photos` do not count wrong passwords.

## Actions

| Action | Who can call it | Payload | Answer (`data`) |
|---|---|---|---|
| `sync` | Anyone | `auth?`, `boardKey?`, `mineV?`, `boardV?` | Depends on the payload, see below |
| `login` | Signed in | `auth` | Full view |
| `saveRsvp` | Signed in | `auth`, `rsvp` | Full view |
| `deleteRsvp` | Signed in | `auth`, `id` | Full view |
| `checkIn` | Signed in | `auth`, `id`, `arrived` | Full view |
| `saveAgent` | CEO | `auth`, `agent` | Full view |
| `deleteAgent` | CEO | `auth`, `name` | Full view |
| `saveEvent` | CEO | `auth`, `event` | Full view plus `auth` |
| `savePhoto` | CEO | `auth`, `name`, `photo` | Full view |
| `photos` | Dashboard key or signed in | `boardKey` or `auth` | `{ v, map }` |

The **full view** is `{ event, agentNames, now, mine, board }`, reflecting the data after the write. You do not need to read again after a write.

### sync

This is the polling call that the page itself makes every 8 seconds.

| Payload field | Effect |
|---|---|
| none | Answer holds only `event`, `agentNames` and `now` |
| `auth` | Adds `mine`, `board` and `photosV`. If the sign-in is wrong, adds `signedOut` (a message) instead |
| `boardKey` | Adds `board` and `photosV`. If the key is wrong, adds `boardKeyBad: true` |
| `mineV` | The last `mine.v` you saw. If unchanged, `mine` is only `{ v, same: true }` |
| `boardV` | The last `board.v` you saw. If unchanged, `board` is only `{ v, same: true }` |

### saveRsvp

Omit `rsvp.id` to create an RSVP. Include it to update one.

An update replaces every editable field, so send the whole record. A field you leave out is cleared or rejected.

| `rsvp` field | Required | Rules |
|---|---|---|
| `id` | To update | From a previous answer |
| `agentName` | CEO, when creating | Must be on the agents list. Sets or changes the owner. Ignored for agents, whose guests are always their own |
| `name` | Yes | 2 to 80 characters |
| `mobile` | Yes | See [mobile numbers](#mobile-numbers). Must not already be on the list |
| `party` | Yes | Whole number, 1 to 20 |
| `status` | Yes | Exactly `Confirmed`, `Maybe`, `Awaiting` or `Declined` |
| `arrival` | No | A time such as `18:30` or `6:30 pm`, stored as `HH:MM` |
| `interest` | No | `Studio / 1 BR`, `2 BR`, `3 BR+`, `Villa / Townhouse`, `Investment`, `Commercial` or `Not sure yet`. Any other value is stored as blank without an error |
| `budget` | No | `Under AED 1M`, `AED 1M - 2M`, `AED 2M - 5M` or `AED 5M+`. Any other value is stored as blank without an error |
| `notes` | No | Up to 500 characters |

The server sets `created`, `updated` and new `id` values. It strips any leading `=`, `+`, `-` or `@` from `name` and `notes`, so a value cannot run as a formula in the Sheet.

### deleteRsvp

Payload: `{ auth, id }`. Deletes the row permanently.

### checkIn

Payload: `{ auth, id, arrived }`. `arrived: true` records the time and who checked the guest in. `arrived: false` clears them. It does not change `updated`.

### saveAgent

Payload: `{ auth, agent: { name, code, original? } }`.

| Field | Rules |
|---|---|
| `name` | 2 to 40 characters, unique. `admin`, `manager` and `ceo` are reserved |
| `code` | The agent's password. 3 to 30 characters, unique among agents |
| `original` | The agent's current name, when updating or renaming. Omit it to add a new agent |

Renaming an agent here also renames them on all their guests and carries their photo over.

### deleteAgent

Payload: `{ auth, name }`. The agent can no longer sign in, their photo is removed, and their guests stay under their name.

### saveEvent

Payload: `{ auth, event }`. A CRM connection should not normally need this. Send the whole object each time: leaving out `open` closes RSVPs, and leaving out `daily` turns the event into a single date.

| `event` field | Rules |
|---|---|
| `name` | Up to 60 characters |
| `tagline` | Up to 80 characters |
| `daily` | `true` if the event runs every day |
| `date` | `YYYY-MM-DD`. With `daily`, the first day. Without it, the one date |
| `start`, `end` | Required, for example `09:00` and `22:00`, Dubai time |
| `venue` | Up to 120 characters |
| `open` | `false` stops agents adding, editing or removing guests |
| `adminPin` | Optional new CEO PIN, 6 to 8 digits. The answer's `auth` then holds the new PIN |
| `newBoardKey` | Optional. `true` replaces the dashboard key, which turns off old dashboard links |

### photos and savePhoto

`photos` returns `{ v, map }`, where `map` goes from the agent's name in lower case to a small image as a data URL.

`savePhoto` takes `{ auth, name, photo }`. `photo` is a `data:image/webp`, `jpeg` or `png` base64 URL of up to 45,000 characters. An empty `photo` removes it.

## What the answers contain

### event

```json
{ "name": "DEEN Open House", "tagline": "", "date": "2026-11-13", "daily": true,
  "start": "09:00", "end": "22:00", "venue": "Sample venue, Business Bay",
  "open": true, "offset": "+04:00" }
```

`date` is the first day when `daily` is true, or the single date when it is false. It is blank if the event simply runs every day with no start date. `open` is false when RSVPs are closed.

### Top-level fields

| Field | Meaning |
|---|---|
| `agentNames` | Everyone on the sign-in list. Public |
| `now` | Server time, Unix milliseconds |
| `photosV` | Changes when any photo changes |

### mine

| Field | Who gets it | Meaning |
|---|---|---|
| `who` | Everyone | `{ id, name, role }`, where `role` is `admin` or `agent` |
| `open` | Everyone | Whether RSVPs are open |
| `rsvps` | Everyone | The CEO gets all RSVPs. An agent gets their own |
| `v` | Everyone | Hash of this section, for `mineV` |
| `agents` | CEO | `[{ name, code }]`, including every agent's password |
| `settings` | CEO | Same as `event` |
| `boardKey` | CEO | The dashboard key |
| `sheetUrl`, `appUrl` | CEO | Links to the Sheet and the web app |

### The RSVP object

```json
{
  "id": "R-MNNP5JD",
  "created": 1794207179077,
  "updated": 1794207179077,
  "agent": "Sample Agent A",
  "name": "Test Guest 01",
  "mobile": "+971552000000",
  "party": 1,
  "status": "Confirmed",
  "arrival": "18:00",
  "interest": "2 BR",
  "budget": "AED 1M - 2M",
  "notes": "Sample note: prefers a high floor",
  "checkedIn": 0,
  "checkedBy": ""
}
```

### board

The dashboard data. It never holds phone numbers or full guest names.

| `totals` field | Counts |
|---|---|
| `parties` | RSVPs |
| `confirmed` | People in Confirmed RSVPs |
| `confirmedParties` | Confirmed RSVPs |
| `maybe` | People in Maybe RSVPs |
| `awaiting`, `declined` | RSVPs with that status |
| `arrived`, `arrivedParties` | People and RSVPs checked in |
| `todayNew` | RSVPs created today (Dubai time) |
| `todayConfirmed`, `todayArrived` | People |

`board.agents[]` is sorted by confirmed people, then RSVPs, then arrivals, then name:

```json
{ "id": "Sample Agent B", "name": "Sample Agent B", "active": true,
  "confirmed": 18, "parties": 10, "arrived": 0, "today": 10, "todayConfirmed": 18 }
```

`active` is false when the agent has been removed but still has guests.

`board.feed[]` is the 14 newest adds, status changes and check-ins, newest first, with the guest's name shortened:

```json
{ "t": 1794207179195, "who": "Sample Agent B", "action": "added",
  "guest": "Test 3.", "party": 4, "status": "Confirmed" }
```

## Mobile numbers

Numbers are stored as `+` followed by digits.

| Input | Stored as |
|---|---|
| `050 123 4567` | `+971501234567` |
| `501234567` | `+971501234567` |
| `00447700900123` | `+447700900123` |
| `+44 7700 900123` | `+447700900123` |

A number must have 7 to 15 digits. The same number cannot be on two RSVPs, whichever agent holds them.

## Common errors

| `error` | Cause |
|---|---|
| `Unknown action.` | The action name is wrong, or the body is not valid JSON |
| `Please sign in first.` | `auth` is missing |
| `Wrong PIN. N tries left.` / `Wrong ID. N tries left.` | Wrong CEO PIN or agent password |
| `Too many wrong tries. Wait 10 minutes or ask the CEO to check your ID.` | That name is locked |
| `Your name is not on the agents list. Ask the CEO to add you.` | Unknown agent name |
| `The sheet is busy. Try again in a moment.` | The write lock timed out. Retry |
| `RSVPs are closed. Ask the CEO to reopen them.` | An agent tried to change guests while RSVPs are closed |
| `You can only change your own RSVPs.` | An agent tried to edit another agent's guest |
| `This RSVP no longer exists. It may have been removed.` | The `id` in `saveRsvp` is not found |
| `Choose the agent this guest belongs to.` | CEO created an RSVP without a valid `agentName` |
| `This number is already on the list: <name>, under <agent>. Edit that RSVP instead.` | Duplicate mobile, CEO sign-in. Agents get a similar message |
| `Add a valid mobile number, e.g. 050 123 4567 or +44 7700 900123.` | Mobile could not be read |
| `Pick a status.` | `status` is not one of the four values |
| `Party size must be between 1 and 20.` | `party` is out of range |
| `Server error: <detail>` | An unexpected failure in the script |

## The Google Sheet

The server reads and writes these tabs. Do not rename a tab or reorder its columns.

**RSVPs**: one row per guest.

| Column | RSVP field | Column | RSVP field |
|---|---|---|---|
| ID | `id` | Status | `status` |
| Created | `created` | Arrival time | `arrival` |
| Updated | `updated` | Interested in | `interest` |
| Agent name | `agent` | Budget | `budget` |
| Guest name | `name` | Notes | `notes` |
| Mobile | `mobile` | Checked in | `checkedIn` |
| Party size | `party` | Checked in by | `checkedBy` |

**Agents**: `Name` and `ID`. The `ID` column holds the agent's password.

**Settings**: `Key`, `Value` and `What it is`.

| Key | Meaning |
|---|---|
| `event_name`, `tagline`, `venue` | Event details |
| `date` | `daily`, `daily from YYYY-MM-DD` or a single `YYYY-MM-DD` |
| `start_time`, `end_time` | Opening hours, 24-hour Dubai time |
| `rsvp_open` | `yes` or `no` |
| `board_key` | Secret part of the dashboard link |
| `admin_pin` | The CEO PIN |

**Photos**: `Name` and `Photo` (a data URL).

**Activity**: `Time`, `Who`, `Action`, `Guest`, `Party size`, `Status`, `RSVP ID` and `Details`, newest at the bottom. `Action` is one of `added`, `updated`, `status`, `removed`, `checked in`, `check-in undone`, `agent added`, `agent updated`, `agent removed`, `event updated`, `photo updated` or `photo removed`.
