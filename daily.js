/**
 * Unattended daily runner.
 *
 * Pulls a rolling window (default: last 30 days) for every account × report and
 * pushes it to Airtable. Designed to be fired by launchd with no human present:
 *
 *   - never blocks on a prompt (CONFIG.unattended)
 *   - one failing report never stops the other eight
 *   - retries transient failures, but fails fast when RTS wants a human
 *   - emails a summary when anything goes wrong
 *   - refuses to start if a previous run is still going
 *   - hard-stops on a watchdog so a hung browser can't run until tomorrow
 *
 * Run manually with:  npm run daily
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  CONFIG,
  NeedsHumanLoginError,
  runRTSDefault,
  runRTSChandi,
  runRTS313,
  runPaymentsRTSDefault,
  runPaymentsRTSChandi,
  runPaymentsRTS313,
  runRecoursedRTSDefault,
  runRecoursedRTSChandi,
  runRecoursedRTS313,
} from './index.js';
import { sendAlert, missingMailConfig } from './notify.js';

// ---------------------------------------------------------------------------
// Tunables (all overridable from .env so you never have to edit this file)
// ---------------------------------------------------------------------------
const LOOKBACK_DAYS = Number(process.env.RTS_LOOKBACK_DAYS || 30);
const ATTEMPTS_PER_JOB = Number(process.env.RTS_ATTEMPTS || 2);
const RETRY_DELAY_MS = Number(process.env.RTS_RETRY_DELAY_MS || 60_000);
const JOB_TIMEOUT_MS = Number(process.env.RTS_JOB_TIMEOUT_MIN || 30) * 60_000;
const RUN_TIMEOUT_MS = Number(process.env.RTS_RUN_TIMEOUT_MIN || 240) * 60_000;
const KEEP_DOWNLOADS_DAYS = Number(process.env.RTS_KEEP_DOWNLOADS_DAYS || 7);
const KEEP_LOGS_DAYS = Number(process.env.RTS_KEEP_LOGS_DAYS || 30);
const STALE_LOCK_MS = 6 * 60 * 60_000;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(ROOT, 'logs');
const DOWNLOADS_DIR = path.join(ROOT, 'downloads');
const LOCK_FILE = path.join(ROOT, '.daily.lock');

// ---------------------------------------------------------------------------
// Unattended mode
// ---------------------------------------------------------------------------
CONFIG.unattended = true; // throw instead of waiting for a human at the login wall
CONFIG.autoClose = true;  // no "press ENTER to close" between reports
CONFIG.verbose = false;   // don't dump whole Maps into a daily log file
CONFIG.headless = process.env.RTS_HEADLESS !== '0';

// ---------------------------------------------------------------------------
// Logging — tee console output to logs/daily-<date>.log, keep a tail for email
// ---------------------------------------------------------------------------
const TAIL_LIMIT = 300;
const tail = [];
let logFd = null;

function pad(n) {
  return String(n).padStart(2, '0');
}

function stampFor(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clockFor(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function setupLogging(startedAt) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `daily-${stampFor(startedAt)}.log`);
  // Sync fd, not a WriteStream: we end on process.exit(), which would drop
  // anything still sitting in a stream's buffer.
  logFd = fs.openSync(file, 'a');

  const wrap = (original) => (...args) => {
    const line = util.format(...args);
    const stamped = `[${clockFor(new Date())}] ${line}`;
    try {
      fs.writeSync(logFd, `${stamped}\n`);
    } catch {
      /* a full disk must not crash the run */
    }
    tail.push(stamped);
    if (tail.length > TAIL_LIMIT) tail.shift();
    original(line);
  };

  console.log = wrap(console.log.bind(console));
  console.warn = wrap(console.warn.bind(console));
  console.error = wrap(console.error.bind(console));

  return file;
}

// ---------------------------------------------------------------------------
// Date window — RTS wants MM/DD/YYYY, separated by an EN DASH (not a hyphen)
// ---------------------------------------------------------------------------
function rollingRange(days, today = new Date()) {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));

  const fmt = (d) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
  return `${fmt(start)} – ${fmt(end)}`;
}

// ---------------------------------------------------------------------------
// Single-instance lock
// ---------------------------------------------------------------------------
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    const pid = Number(raw.split('\n')[0]);
    const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;

    if (Number.isInteger(pid) && processAlive(pid) && age < STALE_LOCK_MS) {
      return { ok: false, pid, ageMinutes: Math.round(age / 60_000) };
    }
    console.warn(`[lock] Clearing stale lock (pid ${pid}, ${Math.round(age / 60_000)}m old).`);
    fs.rmSync(LOCK_FILE, { force: true });
  }

  fs.writeFileSync(LOCK_FILE, `${process.pid}\n${new Date().toISOString()}\n`);
  return { ok: true };
}

function releaseLock() {
  try {
    fs.rmSync(LOCK_FILE, { force: true });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Housekeeping — the downloads folder grows by ~9 xlsx per run otherwise
// ---------------------------------------------------------------------------
function pruneOldFiles(dir, days) {
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - days * 24 * 60 * 60_000;
  let removed = 0;

  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.mtimeMs < cutoff) {
        fs.rmSync(file, { force: true });
        removed++;
      }
    } catch {
      /* skip anything we can't stat/remove */
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
// `key` matches the ACCOUNTS keys in index.js, so an alert can name the exact
// `npm run login <key>` the operator needs to type.
const JOBS = [
  { key: 'default', account: 'RTS Default', report: 'Purchases', run: runRTSDefault },
  { key: 'default', account: 'RTS Default', report: 'Payments', run: runPaymentsRTSDefault },
  { key: 'default', account: 'RTS Default', report: 'Recoursed', run: runRecoursedRTSDefault },
  { key: 'chandi', account: 'RTS Chandi', report: 'Purchases', run: runRTSChandi },
  { key: 'chandi', account: 'RTS Chandi', report: 'Payments', run: runPaymentsRTSChandi },
  { key: 'chandi', account: 'RTS Chandi', report: 'Recoursed', run: runRecoursedRTSChandi },
  { key: '313', account: 'RTS 313', report: 'Purchases', run: runRTS313 },
  { key: '313', account: 'RTS 313', report: 'Payments', run: runPaymentsRTS313 },
  { key: '313', account: 'RTS 313', report: 'Recoursed', run: runRecoursedRTS313 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * RTS device-trust ("Remember this device") lasts 30 days. login.js stamps
 * .mfa-<key>.json when it's established; warn before it lapses rather than
 * letting the job simply fail one morning.
 */
const TRUST_DAYS = 30;
const WARN_AT_DAYS = Number(process.env.RTS_TRUST_WARN_DAYS || 25);

function deviceTrustStatus() {
  const rows = [];
  for (const key of [...new Set(JOBS.map((j) => j.key))]) {
    const file = path.join(ROOT, `.mfa-${key}.json`);
    if (!fs.existsSync(file)) {
      rows.push({ key, days: null, note: 'never established' });
      continue;
    }
    try {
      const { verifiedAt } = JSON.parse(fs.readFileSync(file, 'utf8'));
      const days = Math.floor((Date.now() - new Date(verifiedAt).getTime()) / 86_400_000);
      rows.push({ key, days, note: `${days}d old, ~${Math.max(0, TRUST_DAYS - days)}d left` });
    } catch {
      rows.push({ key, days: null, note: 'unreadable marker' });
    }
  }
  return rows;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${Math.round(ms / 60_000)} min — giving up on it.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runJob(job, dateRange) {
  const label = `${job.account} / ${job.report}`;

  for (let attempt = 1; attempt <= ATTEMPTS_PER_JOB; attempt++) {
    try {
      console.log(`\n>>> ${label} — attempt ${attempt}/${ATTEMPTS_PER_JOB}`);
      await withTimeout(job.run(dateRange), JOB_TIMEOUT_MS, label);
      console.log(`<<< ${label} — OK`);
      return { status: 'ok', label, key: job.key };
    } catch (err) {
      // A 2FA/consent wall will not clear itself; retrying just burns 30 minutes.
      if (err instanceof NeedsHumanLoginError || err?.name === 'NeedsHumanLoginError') {
        console.error(`<<< ${label} — NEEDS HUMAN LOGIN: ${err.message}`);
        return { status: 'needs-login', label, key: job.key, error: err.message };
      }

      console.error(`<<< ${label} — attempt ${attempt} failed: ${err.message}`);
      if (attempt < ATTEMPTS_PER_JOB) {
        console.log(`    retrying in ${Math.round(RETRY_DELAY_MS / 1000)}s...`);
        await sleep(RETRY_DELAY_MS);
      } else {
        return { status: 'failed', label, key: job.key, error: err.message };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const startedAt = new Date();
  const logFile = setupLogging(startedAt);
  const dateRange = rollingRange(LOOKBACK_DAYS, startedAt);

  console.log('='.repeat(72));
  console.log(`RTS Audit — daily run  |  ${startedAt.toISOString()}`);
  console.log(`Window: ${dateRange}  (${LOOKBACK_DAYS}-day rolling)`);
  console.log(`Headless: ${CONFIG.headless}  |  Airtable base: ${CONFIG.airtable.baseId}`);
  console.log(`Log: ${logFile}`);
  console.log('='.repeat(72));

  const missing = missingMailConfig();
  if (missing.length) {
    console.warn(`[notify] Heads up — alerts are OFF (missing ${missing.join(', ')} in .env).`);
  }

  const results = [];
  const blockedAccounts = new Set();

  for (const job of JOBS) {
    // If this account already hit a login wall, its other reports will too.
    if (blockedAccounts.has(job.account)) {
      console.log(`\n--- Skipping ${job.account} / ${job.report} (account needs a human login) ---`);
      results.push({ status: 'skipped', label: `${job.account} / ${job.report}`, key: job.key, error: 'account blocked on login' });
      continue;
    }

    const result = await runJob(job, dateRange);
    results.push(result);
    if (result.status === 'needs-login') blockedAccounts.add(job.account);
  }

  const pruned = pruneOldFiles(DOWNLOADS_DIR, KEEP_DOWNLOADS_DAYS) + pruneOldFiles(LOG_DIR, KEEP_LOGS_DAYS);
  if (pruned) console.log(`\n[cleanup] Removed ${pruned} old file(s).`);

  const ok = results.filter((r) => r.status === 'ok');
  const needsLogin = results.filter((r) => r.status === 'needs-login');
  const failed = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');
  const minutes = Math.round((Date.now() - startedAt.getTime()) / 60_000);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`SUMMARY (${minutes} min)  ok=${ok.length}  needs-login=${needsLogin.length}  failed=${failed.length}  skipped=${skipped.length}`);
  for (const r of results) console.log(`  ${r.status.toUpperCase().padEnd(12)} ${r.label}${r.error ? ` — ${r.error}` : ''}`);
  console.log('='.repeat(72));

  // Device trust expires on its own clock, independent of today's results.
  const trust = deviceTrustStatus();
  console.log('\nDevice trust (RTS "Remember this device", 30 days):');
  for (const t of trust) console.log(`  ${t.key.padEnd(10)} ${t.note}`);

  const expiring = trust.filter((t) => t.days !== null && t.days >= WARN_AT_DAYS);
  if (expiring.length && !needsLogin.length) {
    await sendAlert(
      `[RTS Audit] Device trust expiring for ${expiring.map((t) => t.key).join(', ')}`,
      [
        'RTS only remembers a device for 30 days. These are close to lapsing —',
        're-authorise now and the nightly job keeps running uninterrupted:',
        '',
        ...expiring.map((t) => `  ${t.key}: ${t.note}`),
        '',
        `    cd ${ROOT}`,
        `    npm run login ${expiring.map((t) => t.key).join(' ')}`,
        '',
        'A browser opens, you type the SMS code, and the box "Remember this device',
        'for 30 days" is ticked automatically. That buys another month.',
      ].join('\n'),
    );
  }

  const problems = [...needsLogin, ...failed, ...skipped];
  if (problems.length) {
    const subject = needsLogin.length
      ? `[RTS Audit] ACTION NEEDED — ${needsLogin.length} account(s) need a manual login`
      : `[RTS Audit] ${failed.length} report(s) failed on ${stampFor(startedAt)}`;

    const body = [
      `RTS Audit daily run — ${startedAt.toString()}`,
      `Window: ${dateRange}`,
      `Duration: ${minutes} min`,
      '',
      `OK: ${ok.length} / ${results.length}`,
      '',
      'Problems:',
      ...problems.map((r) => `  [${r.status}] ${r.label} — ${r.error ?? ''}`),
      '',
      needsLogin.length
        ? [
            'A "needs-login" result means RTS asked for 2FA/consent and no automation can clear it.',
            'Fix: on the Mac, run these two commands once, finish the login in the browser window,',
            'then the nightly job resumes on its own — nothing else to do.',
            '',
            `    cd ${ROOT}`,
            `    npm run login ${[...new Set(needsLogin.map((r) => r.key))].join(' ')}`,
            '',
          ].join('\n')
        : 'These will be retried automatically on the next nightly run.',
      '',
      `Full log: ${logFile}`,
      '',
      'Last log lines:',
      ...tail.slice(-80),
    ].join('\n');

    await sendAlert(subject, body);
  } else {
    console.log('[notify] All 9 reports succeeded — no alert sent.');
    if (process.env.ALERT_ON_SUCCESS === '1') {
      await sendAlert(
        `[RTS Audit] OK — all ${ok.length} reports synced (${stampFor(startedAt)})`,
        `Window: ${dateRange}\nDuration: ${minutes} min\n\nLog: ${logFile}`,
      );
    }
  }

  return failed.length + needsLogin.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Entry — lock, watchdog, guaranteed cleanup
// ---------------------------------------------------------------------------
const lock = acquireLock();
if (!lock.ok) {
  console.error(`[lock] A run is already in progress (pid ${lock.pid}, started ${lock.ageMinutes}m ago) — exiting.`);
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    releaseLock();
    process.exit(130);
  });
}

const watchdog = setTimeout(async () => {
  console.error(`[watchdog] Run exceeded ${Math.round(RUN_TIMEOUT_MS / 60_000)} min — killing it so tomorrow's run is clean.`);
  await sendAlert(
    '[RTS Audit] Run hung and was killed by the watchdog',
    `The daily run passed its ${Math.round(RUN_TIMEOUT_MS / 60_000)}-minute limit and was terminated.\n\nLast log lines:\n${tail.slice(-80).join('\n')}`,
  );
  releaseLock();
  process.exit(2);
}, RUN_TIMEOUT_MS);

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.error('[fatal] Daily run crashed:', err?.stack || err?.message || err);
  await sendAlert(
    '[RTS Audit] Daily run CRASHED',
    `The runner itself threw before finishing.\n\n${err?.stack || err?.message || err}\n\nLast log lines:\n${tail.slice(-80).join('\n')}`,
  );
  exitCode = 1;
} finally {
  clearTimeout(watchdog);
  releaseLock();
  if (logFd !== null) try { fs.closeSync(logFd); } catch { /* ignore */ }
}

// Explicit exit: Playwright can leave handles open that would keep node alive.
process.exit(exitCode);
