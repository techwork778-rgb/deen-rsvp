# DEEN Open House RSVP: CRM connection package

This package is for the developer connecting the DEEN Open House RSVP system to the company CRM. It contains the code that is live today, a full API reference and a local test server that needs no Google account.

It does not contain passwords, the CEO PIN, guest data, staff photos or access to any company account. See [What to ask DEEN for](#what-to-ask-deen-for).

Prepared 9 November 2026. The code matches the live system (Apps Script deployment version 7).

## How the system works

```
 Browsers (agents, CEO)                CRM (to be connected)
 static page on Cloudflare Pages              |
             |                                |
             +------ POST JSON over HTTPS ----+
                             |
                             v
          Google Apps Script web app (apps-script/Code.gs)
          one URL, one entry point: { action, payload }
                             |
                             v
          Google Sheet (private), the only database
          tabs: RSVPs, Agents, Settings, Photos, Activity
```

There is no other server or database. Agents add the guests they invite, and each guest is one row in the `RSVPs` tab. The CEO sees every guest, and agents see only their own.

The live API URL is:

```
https://script.google.com/macros/s/AKfycbxxSuiDPEaALUZ6BN2KvW1ar9XHsG6OS95ZTi4guEIxa5UQBdlJHpYdYuIcUIz964Q/exec
```

[API.md](API.md) documents every action, field and error.

One naming point: the code calls an agent's sign-in password the agent's "ID" or `code`. They are the same thing.

## What is in this folder

| Path | What it is | Do you need it for the CRM? |
|---|---|---|
| `README.md` | This guide | Yes, start here |
| `API.md` | Every API action, field and error, plus the Sheet's columns | Yes, main reference |
| `apps-script/Code.gs` | The server, exactly as deployed | Yes, a CRM feed or webhook is added here |
| `dev/` | Local test server that runs `Code.gs` unchanged against a fake Sheet | Yes, to build and test without touching live data |
| `apps-script/Index.html` | The built page that the Apps Script project also serves | Keep it in the project, no change needed |
| `site/` | The built page that is live on Cloudflare Pages | Only if the page changes |
| `src/`, `build.mjs`, `deploy.json` | Page source and its build | Only if the page changes. `src/app-core.js` shows how the page calls the API |

## Connecting the CRM

The system has no CRM-specific endpoint yet. Option A is the recommended way to add one.

| | How it works | Change to the server | Credential the CRM holds |
|---|---|---|---|
| **A. Read-only feed (recommended)** | CRM polls one new action | Small, no new Google permissions | Its own key |
| **B. Existing API** | CRM signs in as the CEO | None | CEO PIN |
| **C. Webhook** | Server pushes each change to the CRM | Larger, needs a new Google permission | CRM's own webhook secret |

### Option A: read-only feed with its own key

The CRM polls one new action and receives every RSVP. It never holds the CEO PIN and never receives agent passwords. This change has been tested on the local test server in `dev/`, but it is not on the live system yet.

1. Create a key, for example with `openssl rand -hex 24`.

2. In the Google Sheet's `Settings` tab, add a row at the bottom with `crm_key` in column A and the key in column B.

3. In `apps-script/Code.gs`, add this line to the `ACTIONS` object:

   ```js
   crmExport: crmExport_,
   ```

4. In the same file, add this line to the object returned by `readSettings_()`:

   ```js
   crmKey: str_(map.crm_key, 80),
   ```

5. Add this function anywhere in the file:

   ```js
   /** Read-only feed for the CRM. It has its own key, so the CRM never needs the CEO PIN. */
   function crmExport_(p) {
     const d = loadData_();
     const key = d.settings.crmKey;
     if (!key || key.length < 24 || String(p.key || '') !== key) throw userError_('Bad CRM key.');
     const rsvps = d.rsvps.map(function (r) {
       return { id: r.id, created: r.created, updated: r.updated, agent: r.agent, name: r.name, mobile: r.mobile,
         party: r.party, status: r.status, arrival: r.arrival, interest: r.interest, budget: r.budget,
         notes: r.notes, checkedIn: r.checkedIn, checkedBy: r.checkedBy };
     });
     const v = hash_(JSON.stringify(rsvps));
     if (p.v === v) return { v: v, same: true, now: Date.now() };
     return { v: v, now: Date.now(), event: publicEvent_(d.settings),
       agents: d.agents.map(function (a) { return a.name; }), rsvps: rsvps };
   }
   ```

6. Deploy it as described in [Deploying a server change](#deploying-a-server-change).

The CRM then calls it like this:

```bash
curl -sL -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"action":"crmExport","payload":{"key":"YOUR_CRM_KEY"}}' \
  "https://script.google.com/macros/s/AKfycbxxSuiDPEaALUZ6BN2KvW1ar9XHsG6OS95ZTi4guEIxa5UQBdlJHpYdYuIcUIz964Q/exec"
```

The answer is `{ "ok": true, "data": { v, now, event, agents, rsvps } }`. See [the RSVP object](API.md#the-rsvp-object) for the fields.

To keep the CRM in step:

- Poll every 1 to 5 minutes.
- Send the last `v` back as `payload.v`. If nothing changed, the answer is only `{ v, same: true, now }`.
- Upsert on `id`. An `id` that is no longer in the feed means the RSVP was removed.

This feed is read-only. If the CRM must also create or change RSVPs, add a write action the same way or use Option B for the writes.

### Option B: the existing API with the CEO sign-in

This works today with no code change. Call `sync` with `auth: { "id": "admin", "pin": "<CEO PIN>" }` and read `data.mine.rsvps`. Write with `saveRsvp`, `checkIn` and `deleteRsvp`.

The drawbacks are why it is not the first choice:

- The CEO PIN has to be stored in the CRM, and changing the PIN breaks the connection.
- Every CEO answer also contains all agents' passwords (`mine.agents[].code`) and the dashboard key (`mine.boardKey`). Do not log or store them.
- Poll with `sync`, not `login`. A wrong PIN on `login` counts toward a 10-minute lock on the CEO sign-in. On `sync` it does not.

### Option C: push changes to the CRM

If the CRM must hear about changes immediately, `Code.gs` can POST to a CRM webhook from `saveRsvp_`, `deleteRsvp_` and `checkIn_`.

- `UrlFetchApp` needs a new Google permission (`script.external_request`), so the Sheet's owner has to authorise the script again.
- Send after `withLock_` has finished. Otherwise a slow CRM holds up every agent's save.
- Failed deliveries need a retry, and edits typed directly into the Sheet do not trigger a push. Keep the Option A feed as a periodic reconciliation.

### Not recommended: reading the Sheet directly

Google shares a spreadsheet as a whole. Giving the CRM access to the Sheet (a service account, for example) also exposes the `Agents` tab, which holds the passwords, and the `Settings` tab, which holds the CEO PIN and dashboard key.

## Suggested field mapping

| RSVP field | Typical CRM field | Notes |
|---|---|---|
| `id` | External ID | Stable for the life of the RSVP. Use it for upserts |
| `name` | Contact name | As typed by the agent |
| `mobile` | Phone | `+` and digits. Each number can appear only once across all RSVPs |
| `agent` | Lead owner | Full name. Agents have no numeric ID, so map them to CRM users by name |
| `status` | Lead stage | `Confirmed`, `Maybe`, `Awaiting` or `Declined` |
| `party` | Custom number | People in the guest's party, 1 to 20 |
| `interest` | Unit type | May be blank |
| `budget` | Budget range | May be blank |
| `arrival` | Custom time | Expected arrival, `HH:MM` Dubai time. May be blank |
| `notes` | Notes | Up to 500 characters |
| `created`, `updated` | Created and modified dates | Unix milliseconds |
| `checkedIn`, `checkedBy` | Attended, attended by | `checkedIn` is `0` until the guest arrives |

## What to ask DEEN for

These are not in the package and should be handed over privately, not by email or chat groups.

| You need | For | Notes |
|---|---|---|
| The server change deployed | Options A and C | Editing the script requires editor access to the Sheet, which also shows the passwords. DEEN may prefer to apply the change itself from the instructions above |
| The `crm_key` value | Option A | DEEN can add the row and give you only the key |
| The CEO PIN | Option B only | Avoid this if Option A is possible |
| The CRM's field names and which CRM user each agent maps to | All options | The agent names come from the API (`agentNames`) |

## Deploying a server change

1. Sign in with the Google account that owns the Sheet, in a browser profile where it is the only Google account. Apps Script links can fail when several accounts are signed in.
2. Open the Sheet, then **Extensions > Apps Script**.
3. Update `Code.gs` and save.
4. Choose **Deploy > Manage deployments**, click the pencil icon, set **Version** to **New version**, and click **Deploy**.

The `/exec` URL stays the same. Do not use **New deployment**, because it creates a different URL and the live page would keep calling the old one.

The web app settings are **Execute as: Me** and **Who has access: Anyone**. To roll back, choose the previous version in **Manage deployments**.

A CRM connection should not need any page changes. If one does, edit `src/`, run `node build.mjs` and `node dev/check.mjs`, and give DEEN the new `site/index.html` to publish.

## Testing locally

The test server runs `Code.gs` unchanged against an in-memory Sheet with sample data. It needs Node 18 or later and no Google account.

```bash
node build.mjs
node dev/server.mjs
```

In a second terminal, load the sample data. This prints a sample CEO PIN, dashboard key and five sample agents:

```bash
curl -X POST http://localhost:8793/__dev/seed
```

Then call the API at `http://localhost:8793/__exec`. It takes the same requests as the live URL, without the redirect:

```bash
curl -s -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"action":"login","payload":{"auth":{"id":"admin","pin":"PIN_FROM_SEED"}}}' \
  http://localhost:8793/__exec
```

| Local address | What it does |
|---|---|
| `GET /` | The page as Apps Script serves it |
| `GET /hosted` | The page as it runs on Cloudflare (run `node build.mjs` first) |
| `GET /__dev/sheet` | Raw contents of every tab |
| `POST /__dev/seed` | Replaces everything with sample data |
| `POST /__dev/reset` | Empties the Sheet |

The fake Sheet is saved to `dev/sheet.local.json`. `node dev/check.mjs` syntax-checks the deploy files. The server reloads `Code.gs` whenever the file changes.

## Behaviour to plan for

**Requests**

- A POST to `/exec` answers with a 302 redirect to `script.googleusercontent.com`, and the result comes from following it with a GET. See [Calling the API](API.md#calling-the-api).
- Application errors still arrive as HTTP 200 with `{ "ok": false, "error": "..." }`, so always check `ok`.
- A live call takes around 2 seconds because each one runs on Apps Script and reads a Sheet.
- Only one write runs at a time. If the lock is not free within 15 seconds, the answer is `The sheet is busy. Try again in a moment.` Retry in that case.
- Google's limits are listed at https://developers.google.com/apps-script/guides/services/quotas. Each open browser also polls every 8 seconds, so keep CRM polling modest.

**Data**

- Reads are cached for up to 20 seconds, so edits typed directly into the Sheet can take that long to appear. Writes through the API clear the cache at once.
- Do not rely on `updated` to detect changes. Check-ins, agent renames and edits typed into the Sheet do not change it. Use `v`, or compare whole records.
- Removing an RSVP deletes its row. The only trace left is a `removed` entry in the `Activity` tab, which holds the RSVP ID and mobile number.
- Timestamps are Unix milliseconds, and `0` means not set. The event's dates and times are Dubai time (UTC+4, no daylight saving).
- Renaming an agent in the app updates the name on all their guests and leaves each `id` unchanged. Renaming directly in the Sheet does not update their guests.
- Guest names and phone numbers are personal data. Keep keys and PINs out of URLs and logs, and restrict who can read the feed.
