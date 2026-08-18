# RTS Audit

Automates pulling RTS Financial reports into Airtable. Supports multiple RTS accounts and two report types:

- **Purchases** — RTS Pro Purchase Report → 6 RTS amount fields per matched Airtable load.
- **Payments** — RTS Pro Payments Report → payment date, check #, activity type, and check amount per matched Airtable load.

## Stack

- **Playwright** — browser automation (Auth0 login, navigation, downloads)
- **xlsx** — parses the Excel files RTS exports
- **Airtable REST API** — record lookup + updates (`airtable.js`)
- **dotenv** — credentials from `.env`

## Setup

1. Install dependencies:
   ```bash
   npm install
   npx playwright install chromium
   ```

2. Create `.env`:
   ```
   RTS_USER=...
   RTS_PASS=...

   RTS_CHANDI_USER=...
   RTS_CHANDI_PASS=...

   RTS_313_USER=...
   RTS_313_PASS=...

   AIRTABLE_TOKEN=pat_your_personal_access_token
   ```

3. (Optional) Adjust `CONFIG` in `index.js`:
   - `airtable.baseId`, `airtable.tableId`
   - `airtable.dispatchField`, `loadField`, `customerField`, `collectField` — fields used for matching
   - `airtable.fieldMap` — Excel → Airtable field name map
   - `selectors.*` — Playwright selectors (most marked `// TODO: confirm` if RTS UI changes)

## Running

There are six runner functions exported at the bottom of `index.js`. Pick one by uncommenting it (and commenting the others):

```js
const DATE_RANGE = '01/01/2026 – 01/31/2026';

// === PURCHASES (writes 6 RTS amount fields) ===
// runRTSDefault(DATE_RANGE).catch(...);
// runRTSChandi(DATE_RANGE).catch(...);
// runRTS313(DATE_RANGE).catch(...);

// === PAYMENTS (writes payment date / check # / activity type / check amount) ===
runPaymentsRTSDefault(DATE_RANGE).catch(...);
// runPaymentsRTSChandi(DATE_RANGE).catch(...);
// runPaymentsRTS313(DATE_RANGE).catch(...);
```

Then:
```bash
npm run dev
```

The first run for each account opens a non-headless Chromium, autofills credentials, and waits for you to confirm login (so 2FA / consent screens can be handled). On confirmation the session is persisted to `auth-<account>.json` so subsequent runs skip login.

> **Note on the date format**: the date input on the RTS page uses an en-dash (`–`), not a hyphen. Keep `DATE_RANGE` formatted exactly like `MM/DD/YYYY – MM/DD/YYYY`.

## Accounts

Each account in `ACCOUNTS` (top of `index.js`) maps to its own env-var pair and storage-state file:

| Key       | Display name  | Env vars                          | Auth file              |
| --------- | ------------- | --------------------------------- | ---------------------- |
| `default` | RTS Default   | `RTS_USER`, `RTS_PASS`            | `auth-default.json`    |
| `chandi`  | RTS Chandi    | `RTS_CHANDI_USER`, `RTS_CHANDI_PASS` | `auth-chandi.json`  |
| `313`     | RTS 313       | `RTS_313_USER`, `RTS_313_PASS`    | `auth-313.json`        |

## Purchases flow

1. Navigate to `/factoring/reports/purchase-report`.
2. Set date range, click View.
3. Set rows-per-page to 100.
4. For each row: click → click the download icon → save Excel → parse → store in an in-memory Map keyed by Excel `Invoice #`.
5. Click View between rows to refresh the list.
6. Push the Map to Airtable.

**Matching strategy** — Excel `Invoice #` may be either Airtable `Dispatch #` (5 digits) or `Load Number` (any length):

1. Fetch records where `Dispatch #` OR `Load Number` matches the invoice (deduped by record ID).
2. Verify each candidate using:
   - **Fuzzy customer match** — token-overlap ratio of Excel `Customer` vs Airtable `Customer` (drops company-suffix stopwords like `inc`, `llc`, `dba`).
   - **Collect amount match** — Excel `Invoice Amount` vs Airtable `Collect` (1¢ tolerance).
3. A candidate scores `customerSim + (collectMatch ? 1 : 0)`. Threshold: `0.5`.

Records that match by number but fail verification are reported as **Ambiguous**. Invoices with no number match are reported as **Unmatched**.

**Fields written** (mapped via `CONFIG.airtable.fieldMap`):

| Excel column     | Airtable field        |
| ---------------- | --------------------- |
| `Held Amount`    | `RTS Held Amount`     |
| `Denied Amount`  | `RTS Denied Amount`   |
| `Days Due`       | `RTS Days Dues`       |
| `Fee`            | `RTS Fee`             |
| `Reserve Escrow` | `RTS Reserve Escrow`  |
| `Funded Amount`  | `RTS Funded Amount`   |

## Payments flow

1. Navigate to `/factoring/reports/payments-report`.
2. Set date range, click View.
3. Wait ~8s for report to render.
4. Click the page-level download icon — a single Excel containing all payment rows for the range.
5. Parse → build a Map keyed by `Invoice Number` (falling back to `Load Number`).
6. Push to Airtable.

**Matching strategy** — same dual-key lookup (`Dispatch #` OR `Load Number`). Each match takes the first candidate and updates it. (See note in `pushPaymentsToAirtable` if you want to add fuzzy debtor / amount verification later.)

**Fields written:**

| Excel column     | Airtable field      |
| ---------------- | ------------------- |
| `Payment Date`   | `RTS Payment Date`  |
| `Check Number`   | `RTS Check Number`  |
| `Activity Type`  | `RTS Activity Type` |
| `Check Amount`   | `RTS Check Amount`  |

Empty cells in the Excel are skipped so existing Airtable values aren't overwritten with blanks.

## Daily automated run

`daily.js` runs **all 9 combinations** (3 accounts × 3 reports) unattended over a
rolling 30-day window, and `launchd` fires it once a day.

### One-time setup

```bash
cp .env.example .env          # fill in RTS creds, Airtable PAT, SMTP settings
npm install
npx playwright install chromium
```

Then establish a session for each account once, by hand — this is the only step a
human is required for:

```bash
npm run login                 # all three, one after another
npm run login chandi          # or just one
```

A browser opens per account, credentials autofill, you enter the SMS code, and
the session is saved to `auth-<account>.json`. `login.js` never touches Airtable,
so it's safe to re-run.

### The 30-day ceiling — read this

RTS protects login with **SMS multi-factor auth**, and no automation can clear
it. The login flow really is:

```
rtspro.com → language gate → Welcome screen ("Log In")
           → auth.rtspro.com  → email → password
           → SMS code to the account's phone
```

What makes unattended running possible is the **"Remember this device for 30
days"** checkbox on the code screen. `login.js` ticks it for you and tells you
whether it succeeded. So the real cost is:

| | |
| --- | --- |
| Human effort | ~1 minute, once every 30 days, per account |
| Everything in between | fully automatic |

`login.js` stamps `.mfa-<account>.json` when trust is established. The nightly
job prints the remaining days each run and **emails you at day 25**, so you
re-authorise before anything breaks rather than after. Tune with
`RTS_TRUST_WARN_DAYS`.

If trust does lapse, the job reports `needs-login`, skips that account's
remaining reports, and emails you the exact command to run. Nothing corrupts;
the next night resumes normally.

Finally, arm the schedule:

```bash
npm run schedule:install                          # daily at 07:00 local
RUN_HOUR=3 RUN_MINUTE=30 npm run schedule:install # or pick your own time
```

| Command                     | What it does                                    |
| --------------------------- | ----------------------------------------------- |
| `npm run login [accounts…]` | Interactive login, saves `auth-*.json`          |
| `npm run daily`             | Run the full sweep now, headless                |
| `npm run daily:visible`     | Same, but with a visible browser (debugging)    |
| `npm run schedule:install`  | Install/replace the LaunchAgent                 |
| `npm run schedule:status`   | Check whether it's loaded                       |
| `npm run schedule:uninstall`| Remove it                                       |

`launchctl kickstart -k gui/$UID/com.handatransportation.rtsaudit` triggers a run
immediately without waiting for the schedule.

### How it survives a bad night

| Failure                          | Behaviour                                                        |
| -------------------------------- | ---------------------------------------------------------------- |
| One report throws                | Retried once after 60s, then skipped — the other 8 still run     |
| A report hangs                   | Killed after 30 min, marked failed, run continues                 |
| The whole run hangs              | Watchdog kills the process after 4h and emails you                |
| RTS session expired (device still trusted) | Credentials are re-submitted automatically, gates cleared, session re-saved — no human |
| Device trust nearing 30 days     | Warning email at day 25, before anything fails                    |
| Device trust lapsed → SMS code   | `needs-login` — that account's remaining reports are skipped, and the email names the exact `npm run login <account>` to run |
| Previous run still going         | New run exits immediately (lock file) instead of double-writing   |
| Mac asleep at the scheduled time | launchd runs the job on wake (this is why it isn't cron)          |
| SMTP broken                      | Logged, run continues — email never takes the job down            |

Nothing ever blocks on a prompt: `waitForEnter` short-circuits when
`CONFIG.unattended` is set *or* when stdin isn't a TTY.

### Output

- `logs/daily-YYYY-MM-DD.log` — timestamped log per run (pruned after 30 days)
- `logs/launchd.{out,err}.log` — whatever launchd itself captures
- `downloads/` — pruned after 7 days

An email goes out **only when something goes wrong**, with the summary table and
the last 80 log lines. Set `ALERT_ON_SUCCESS=1` if you also want a daily all-clear.

### Tuning

Everything is env-driven — see the commented block at the bottom of
`.env.example` (`RTS_LOOKBACK_DAYS`, `RTS_ATTEMPTS`, `RTS_JOB_TIMEOUT_MIN`,
`RTS_RUN_TIMEOUT_MIN`, `RTS_HEADLESS`, …). No need to edit `daily.js`.

## Files

| File                | Purpose                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| `index.js`          | Main entrypoint — Playwright flow, Excel parsing, Airtable orchestration      |
| `daily.js`          | Unattended daily runner — all 9 reports, retries, watchdog, alerting          |
| `login.js`          | Interactive session bootstrap (`npm run login`) — no Airtable writes          |
| `notify.js`         | Best-effort SMTP alert helper (never throws)                                  |
| `airtable.js`       | Airtable REST helpers: `getRecords`, `getRecordsByField`, `updateRecords`     |
| `previous-year.js`  | Backfill script — chunks a past year into monthly ranges, different base      |
| `scripts/*.sh`      | launchd install / uninstall                                                   |
| `auth-*.json`       | Persisted Playwright storage state per account (auto-created after login)     |
| `.env`              | RTS credentials + Airtable PAT + SMTP settings (gitignored)                   |
| `downloads/`        | Saved Excel files + diagnostic screenshots (gitignored)                       |
| `logs/`             | Daily run logs (gitignored)                                                   |
| `package.json`      | Dependencies + scripts                                                        |

## Notes

- **Never commit `.env` or `auth-*.json`.** `.gitignore` covers both.
- If RTS rotates the session, delete the relevant `auth-*.json` and re-run — autofill will re-establish.
- Geolocation is pre-granted to `rtspro.com` to suppress the location prompt.
- The download capture relies on Playwright's `acceptDownloads: true` browser context.
- If a date filter doesn't appear to take effect (you keep getting the same row count for different months), check the `[filter] Input value after typing:` log to confirm the new value reached the input.
- Records updated successfully but invisible in your Airtable view? The view's filter is hiding them — check the table without the view filter to confirm `RTS *` fields are populated.
