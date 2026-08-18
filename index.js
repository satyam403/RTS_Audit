import 'dotenv/config';
import { chromium } from 'playwright';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { getRecordsByField, updateRecords, createRecords } from './airtable.js';

// Resolve against this file, not the CWD — launchd/cron start the process elsewhere.
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = path.join(ROOT_DIR, 'downloads');
const authPath = (file) => path.join(ROOT_DIR, file);

export const ACCOUNTS = {
  default: {
    name: 'RTS Default',
    user: process.env.RTS_USER,
    pass: process.env.RTS_PASS,
    authFile: 'auth-default.json',
  },
  chandi: {
    name: 'RTS Chandi',
    user: process.env.RTS_CHANDI_USER,
    pass: process.env.RTS_CHANDI_PASS,
    authFile: 'auth-chandi.json',
  },
  '313': {
    name: 'RTS 313',
    user: process.env.RTS_313_USER,
    pass: process.env.RTS_313_PASS,
    authFile: 'auth-313.json',
  },
};

export const CONFIG = {
  loginUrl: 'https://rtspro.com/',
  purchaseReportUrl: 'https://rtspro.com/factoring/reports/purchase-report',
  paymentsReportUrl: 'https://rtspro.com/factoring/reports/payments-report',
  recoursedReportUrl: 'https://rtspro.com/factoring/reports/recoursed-report',
  selectors: {
    username: 'input[name="username"]',
    password: 'input[name="password"]',
    submit: 'button[type="submit"]',
    dateRangeInput: 'input[placeholder*="MM/DD/AAAA"]',
    viewButton: 'button:has(span:text-is("View"))',
    purchaseRow: 'table tbody tr',                          // TODO: confirm purchase-report row selector
    downloadIcon: 'svg[data-testid="GetAppIcon"]',
    paginationNext: 'button[aria-label="Go to next page"]', // TODO: confirm — MUI default
    rowsPerPageDropdown: '.MuiTablePagination-select, [aria-haspopup="listbox"]', // TODO: confirm
    rowInvoiceCell: 'td:nth-child(2)', // TODO: confirm column index for Invoice #
  },
  rowsPerPage: 100,
  parallelDownloads: 3,
  dateRange: '04/21/2026 – 04/29/2026',
  airtable: {
    baseId: 'appFZQtRfsGDkCun4',
    tableId: 'tblO5X9igZQEzaWfw',
    unmatchedTableId: 'tblJuB1CbkwZrrRa9', // "RTS Unambigous Loads"
    dispatchField: 'Dispatch #', // 5-digit number
    loadField: 'Load Number',    // any length
    customerField: 'Customer',
    collectField: 'Collect',
    fieldMap: {
      heldAmount: 'RTS Held Amount',
      deniedAmount: 'RTS Denied Amount',
      daysDue: 'RTS Days Dues',
      fee: 'RTS Fee',
      reserveEscrow: 'RTS Reserve Escrow',
      fundedAmount: 'RTS Funded Amount',
      paymentDate: 'RTS Payment Date',
      checkNumber: 'RTS Check Number',
      activityType: 'RTS Activity Type',
      checkAmount: 'RTS Check Amount',
      recourseStatus: 'RTS Recourse Status',
      recourseDate: 'RTS Recourse Date',
    },
  },
  viewport: { width: 1440, height: 900 },
  navTimeoutMs: 90_000, // rtspro.com is slow; the default 30s was aborting real runs
  autoClose: false,  // when true, skips the "Press ENTER to close" prompt at the end of each report
  headless: false,   // daily.js flips this on; keep false for interactive/debug runs
  unattended: false, // when true: never block on a prompt, and throw NeedsHumanLoginError instead of waiting for a human
  verbose: true,     // when false, skips the full-Map console dumps (they blow up log files on big date ranges)
};

/** Thrown in unattended mode when RTS wants a human (2FA / consent / rotated password). */
export class NeedsHumanLoginError extends Error {
  constructor(accountName) {
    super(`${accountName} needs a human login — run \`npm run dev\` interactively once to re-establish the session.`);
    this.name = 'NeedsHumanLoginError';
    this.account = accountName;
  }
}

async function waitForEnter(prompt) {
  // Under launchd/cron there is no TTY — blocking here would hang the job forever.
  if (CONFIG.unattended || !input.isTTY) {
    console.log(`[prompt] Skipped (no human attached): ${prompt.trim()}`);
    return;
  }
  const rl = readline.createInterface({ input, output });
  await rl.question(prompt);
  rl.close();
}

/**
 * rtspro.com puts two click-throughs in front of the Auth0 form: a language
 * chooser, then a Welcome screen with "Create Account" / "Log In". Neither is a
 * login form, so the username selector never appears until both are cleared.
 */
const visible = (page, selector) =>
  page.locator(selector).first().isVisible().catch(() => false);

/**
 * `waitUntil: 'load'` blocks on every last asset, and this SPA regularly never
 * fires it — a 30s nav timeout was killing runs. DOM-ready plus an explicit
 * settle is both faster and far more reliable.
 */
export async function gotoStable(page, url, settleMs = 4000) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.navTimeoutMs });
  await page.waitForTimeout(settleMs);
}

export async function dismissEntryGates(page) {
  for (let pass = 0; pass < 5; pass++) {
    // The shell is a SPA — give it a beat to paint before judging what we see.
    await page.waitForTimeout(2500);

    // Already at the Auth0 form (or past it): nothing left to clear.
    if (await visible(page, CONFIG.selectors.username)) return;
    if (await visible(page, CONFIG.selectors.password)) return;

    // Check "Log In" before "Continue": the Auth0 form also has a Continue button.
    if (await visible(page, 'button:has-text("Log In")')) {
      console.log('[gate] Welcome screen — clicking Log In...');
      await page.locator('button:has-text("Log In")').first().click().catch(() => {});
      await page.waitForTimeout(6000);
      continue;
    }

    if (await visible(page, 'button:has-text("Continue")')) {
      console.log('[gate] Language screen — clicking Continue...');
      await page.locator('button:has-text("Continue")').first().click().catch(() => {});
      await page.waitForTimeout(4000);
      continue;
    }

    return; // nothing recognisable in the way
  }
  console.log('[gate] Gates still present after 5 passes — continuing anyway.');
}

export async function autofillLogin(page, account) {
  if (!account.user || !account.pass) {
    throw new Error(`Missing credentials for ${account.name} (set the RTS_*_USER and RTS_*_PASS env vars)`);
  }

  await dismissEntryGates(page);

  console.log(`[login] Autofilling credentials for ${account.name}...`);
  await page.waitForSelector(CONFIG.selectors.username, { timeout: 20000 });
  await page.fill(CONFIG.selectors.username, account.user);

  const passwordVisibleNow = await visible(page, CONFIG.selectors.password);

  // Auth0 renders duplicate submit buttons and the first is overlapped by the
  // input itself, so clicking it fails. Submitting from the field always works;
  // the button click stays as a fallback in case they change the markup.
  const submitFrom = async (fieldSelector) => {
    await page.locator(fieldSelector).first().press('Enter');
    await page.waitForTimeout(1500);
  };

  if (!passwordVisibleNow) {
    console.log('[login] Submitting identifier step...');
    await submitFrom(CONFIG.selectors.username);
    try {
      await page.waitForSelector(CONFIG.selectors.password, { timeout: 20000 });
    } catch {
      console.log('[login] Enter did not advance — falling back to the submit button.');
      await page.locator(CONFIG.selectors.submit).last().click({ timeout: 10000 }).catch(() => {});
      await page.waitForSelector(CONFIG.selectors.password, { timeout: 20000 });
    }
  }

  console.log('[login] Filling password & submitting...');
  await page.fill(CONFIG.selectors.password, account.pass);
  await submitFrom(CONFIG.selectors.password);
}

function isAuthUrl(url) {
  return /auth\.rtspro\.com|\/u\/login|\/authorize/i.test(url);
}

async function saveSession(context, label, authFile) {
  try {
    await context.storageState({ path: authPath(authFile) });
    console.log(`[auth] Session saved to ${authFile} (${label}).`);
  } catch (err) {
    console.error(`[auth] Failed to save session (${label}):`, err.message);
  }
}

async function isLoginShown(page) {
  if (isAuthUrl(page.url())) return true;

  // The pre-auth gates aren't login forms, but reaching one means we're signed out.
  for (const gate of ['text=Choose Your language', 'button:has-text("Log In")']) {
    if (await page.locator(gate).first().isVisible().catch(() => false)) {
      console.log(`[auth] Pre-login gate detected: ${gate}`);
      return true;
    }
  }

  const candidates = [
    CONFIG.selectors.username,
    CONFIG.selectors.password,
    'input[type="password"]',
    'input[name="email"]',
    'input[type="email"]',
    'form[action*="login" i]',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
  ];

  for (const sel of candidates) {
    const visible = await page.locator(sel).first().isVisible().catch(() => false);
    if (visible) {
      console.log(`[auth] Login indicator detected: ${sel}`);
      return true;
    }
  }
  return false;
}

async function dumpPageDiagnostics(page, label) {
  try {
    const title = await page.title().catch(() => '');
    const url = page.url();
    console.log(`[diag] (${label}) url=${url} title="${title}"`);

    const screenshotPath = path.join(DOWNLOADS_DIR, `diag-${label}-${Date.now()}.png`);
    if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[diag] Screenshot: ${screenshotPath}`);

    const inputs = await page.$$eval('input', (els) =>
      els.map((e) => ({
        name: e.name,
        type: e.type,
        id: e.id,
        placeholder: e.placeholder,
        visible: e.offsetParent !== null,
      })),
    );
    console.log(`[diag] Inputs on page:`, inputs.filter((i) => i.visible));
  } catch (err) {
    console.log(`[diag] Diagnostics failed: ${err.message}`);
  }
}

async function runLoginFlow(page, context, account) {
  console.log('[auth] Running autofill...');
  try {
    await autofillLogin(page, account);
  } catch (err) {
    console.error('[auth] Autofill error (will fall back to manual):', err.message);
    if (CONFIG.unattended) throw new NeedsHumanLoginError(account.name);
  }

  try {
    await page.waitForURL((url) => !isAuthUrl(url.toString()), { timeout: 30000 });
    console.log(`[auth] Auto-redirected to: ${page.url()}`);
  } catch {
    console.log('[auth] Did not auto-redirect — finish login in the browser.');
  }

  if (CONFIG.unattended) {
    // Nobody is watching: confirm autofill actually got us in before we carry on.
    await page.waitForTimeout(3000);
    if (await isLoginShown(page)) {
      await dumpPageDiagnostics(page, `needs-login-${account.authFile.replace(/\W+/g, '-')}`);
      throw new NeedsHumanLoginError(account.name);
    }
    console.log('[auth] Unattended re-login succeeded.');
    await saveSession(context, 'after-login', account.authFile);
    return;
  }

  console.log('\n>>> Make sure you are fully logged into the RTS app (not on the login page).');
  await waitForEnter('>>> Press ENTER here to save the session...\n');

  await saveSession(context, 'after-login', account.authFile);
}

async function navigateAuthenticated(page, context, targetUrl, account) {
  console.log(`[nav] Navigating to ${targetUrl}...`);
  await gotoStable(page, targetUrl);
  console.log(`[nav] Landed at: ${page.url()}`);

  await dumpPageDiagnostics(page, 'after-nav');

  if (await isLoginShown(page)) {
    console.log('[nav] Login required.');
    await runLoginFlow(page, context, account);

    console.log(`[nav] Re-navigating to ${targetUrl}...`);
    await gotoStable(page, targetUrl, 3000);
    console.log(`[nav] Final URL: ${page.url()}`);

    if (await isLoginShown(page)) {
      await dumpPageDiagnostics(page, 'still-login');
      throw new Error(`[nav] Still on login page after login flow — aborting.`);
    }
  }
}

async function launchBrowser(authFile) {
  const resolved = authPath(authFile);
  const hasAuth = fs.existsSync(resolved);
  const browser = await chromium.launch({ headless: CONFIG.headless });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: CONFIG.viewport,
    storageState: hasAuth ? resolved : undefined,
    permissions: ['geolocation'],
    geolocation: { latitude: 39.0997, longitude: -94.5786 },
  });
  await context.grantPermissions(['geolocation'], { origin: 'https://rtspro.com' });
  const page = await context.newPage();
  return { browser, context, page };
}

/** Full-Map dumps are useful interactively but murder log files on 30-day ranges. */
function dumpMap(label, map) {
  if (!CONFIG.verbose) {
    console.log(`${label} ${map.size} entries (set CONFIG.verbose to list them).`);
    return;
  }
  console.log(label);
  console.log(Object.fromEntries(map));
}

function parseMoney(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const cleaned = String(v).replace(/[$,\s]/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function setIfPresent(target, key, value) {
  if (value !== null && value !== undefined && value !== '') {
    target[key] = value;
  }
}

const COMPANY_STOPWORDS = new Set(['inc', 'llc', 'dba', 'co', 'ltd', 'the', 'and', 'corp', 'company']);

function tokenizeCustomer(s) {
  return new Set(
    String(s ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !COMPANY_STOPWORDS.has(t))
  );
}

function customerFuzzyScore(a, b) {
  const ta = tokenizeCustomer(a);
  const tb = tokenizeCustomer(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  const intersection = [...ta].filter((t) => tb.has(t));
  return intersection.length / Math.min(ta.size, tb.size);
}

function amountsMatch(a, b) {
  const na = parseMoney(a);
  const nb = parseMoney(b);
  if (na === null || nb === null) return false;
  return Math.abs(na - nb) < 0.01;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function cleanFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return out;
}

async function pushUnresolvedToAirtable(report, account, rows) {
  const { baseId, unmatchedTableId } = CONFIG.airtable;
  if (!unmatchedTableId) {
    console.log('[unresolved] unmatchedTableId not set — skipping.');
    return;
  }
  if (!rows.length) {
    console.log(`[unresolved] No ${report} unresolved rows for ${account.name}.`);
    return;
  }

  const today = todayISO();

  const records = rows
    .filter((r) => r.loadNumber)
    .map((r) => ({
      key: `${account.name}-${report}-${r.loadNumber}`,
      fields: cleanFields({
        Key: `${account.name}-${report}-${r.loadNumber}`,
        'Load Number': r.loadNumber,
        Customer: r.customer,
        Amount: parseMoney(r.amount),
        Account: account.name,
        Report: report,
        Reason: r.reason,
        'RTS Date': r.rtsDate,
        'Date Found': today,
        'Top Candidate Customer': r.topCandidateCustomer,
      }),
    }));

  if (!records.length) return;

  const keys = records.map((r) => r.key);
  const existing = await getRecordsByField(baseId, unmatchedTableId, 'Key', keys);
  const existingByKey = new Map(existing.map((e) => [e.fields.Key, e]));

  const creates = [];
  const updates = [];
  let skippedResolved = 0;

  for (const rec of records) {
    const ex = existingByKey.get(rec.key);
    if (ex) {
      if (ex.fields.Resolved) {
        skippedResolved++;
        continue;
      }
      const runCount = Number(ex.fields['Run Count'] ?? 0) + 1;
      updates.push({
        id: ex.id,
        fields: cleanFields({
          'Date Found': today,
          'Run Count': runCount,
          'Top Candidate Customer': rec.fields['Top Candidate Customer'],
        }),
      });
    } else {
      creates.push({ fields: { ...rec.fields, 'Run Count': 1 } });
    }
  }

  console.log(
    `[unresolved] ${report}/${account.name}: ${creates.length} new, ${updates.length} bumped, ${skippedResolved} skipped (Resolved).`
  );

  if (updates.length) await updateRecords(baseId, unmatchedTableId, updates);
  if (creates.length) await createRecords(baseId, unmatchedTableId, creates);
}

async function pushPurchasesToAirtable(purchaseMap) {
  const {
    baseId,
    tableId,
    dispatchField,
    loadField,
    customerField,
    collectField,
    fieldMap: fm,
  } = CONFIG.airtable;
  const invoiceNos = Array.from(purchaseMap.keys());

  if (invoiceNos.length === 0) {
    console.log('[airtable] No purchases collected — nothing to push.');
    return;
  }

  console.log(`[airtable] Fetching candidates by ${dispatchField} OR ${loadField}...`);
  const [byDispatch, byLoad] = await Promise.all([
    getRecordsByField(baseId, tableId, dispatchField, invoiceNos),
    getRecordsByField(baseId, tableId, loadField, invoiceNos),
  ]);

  const candidatesById = new Map();
  for (const r of [...byDispatch, ...byLoad]) candidatesById.set(r.id, r);
  const candidates = Array.from(candidatesById.values());
  console.log(`[airtable] ${candidates.length} candidate record(s) (deduped).`);

  const updates = [];
  const matched = new Set();
  const ambiguousRows = [];

  for (const [invoiceNo, purchase] of purchaseMap) {
    // Find candidates whose Dispatch # OR Load # equals this invoice
    const numberMatches = candidates.filter((c) => {
      const d = String(c.fields[dispatchField] ?? '').trim();
      const l = String(c.fields[loadField] ?? '').trim();
      return d === invoiceNo || l === invoiceNo;
    });

    if (numberMatches.length === 0) continue;

    // Verify each candidate with fuzzy customer + collect amount
    let best = null;
    let bestScore = -Infinity;
    let bestDetail = null;

    for (const c of numberMatches) {
      const custSim = customerFuzzyScore(purchase.customer, c.fields[customerField]);
      const collectOk = amountsMatch(purchase.invoiceAmount, c.fields[collectField]);
      const score = custSim + (collectOk ? 1 : 0);

      if (score > bestScore) {
        best = c;
        bestScore = score;
        bestDetail = { custSim, collectOk };
      }
    }

    // Confidence threshold: customer fuzzy >= 0.5 OR collect amount matches
    if (!best || bestScore < 0.5) {
      const topCust = best?.fields?.[customerField];
      ambiguousRows.push({
        loadNumber: invoiceNo,
        customer: purchase.customer,
        amount: purchase.invoiceAmount,
        rtsDate: purchase.date,
        reason: 'Ambiguous',
        topCandidateCustomer: Array.isArray(topCust) ? topCust.join(', ') : topCust,
      });
      continue;
    }

    matched.add(invoiceNo);
    console.log(
      `[airtable] ${invoiceNo} → ${best.id} (custSim=${bestDetail.custSim.toFixed(2)}, collect=${bestDetail.collectOk})`
    );

    const fields = {};
    setIfPresent(fields, fm.heldAmount, parseMoney(purchase.heldAmount));
    setIfPresent(fields, fm.deniedAmount, parseMoney(purchase.deniedAmount));
    setIfPresent(fields, fm.daysDue, parseMoney(purchase.daysDue));
    setIfPresent(fields, fm.fee, parseMoney(purchase.fee));
    setIfPresent(fields, fm.reserveEscrow, parseMoney(purchase.reserveEscrow));
    setIfPresent(fields, fm.fundedAmount, parseMoney(purchase.fundedAmount));

    if (Object.keys(fields).length === 0) continue;
    updates.push({ id: best.id, fields });
  }

  const unmatchedRows = [];
  for (const [invoiceNo, purchase] of purchaseMap) {
    const hadNumberMatch = candidates.some((c) => {
      const d = String(c.fields[dispatchField] ?? '').trim();
      const l = String(c.fields[loadField] ?? '').trim();
      return d === invoiceNo || l === invoiceNo;
    });
    if (!hadNumberMatch) {
      unmatchedRows.push({
        loadNumber: invoiceNo,
        customer: purchase.customer,
        amount: purchase.invoiceAmount,
        rtsDate: purchase.date,
        reason: 'Unmatched',
      });
    }
  }

  console.log(`[airtable] Matched: ${updates.length}, Unmatched: ${unmatchedRows.length}, Ambiguous: ${ambiguousRows.length}`);

  if (updates.length) {
    console.log(`[airtable] Updating ${updates.length} record(s) with 6 RTS fields...`);
    await updateRecords(baseId, tableId, updates);
    console.log(`[airtable] Update complete.`);
  } else {
    console.log('[airtable] Nothing to update.');
  }

  return { unmatched: unmatchedRows, ambiguous: ambiguousRows };
}

function parsePaymentsExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  return rows.map((r) => ({
    invoiceNo: String(r['Invoice Number'] ?? r['Invoice #'] ?? '').trim(),
    loadNumber: String(r['Load Number'] ?? '').trim(),
    purchaseDate: r['Purchase Date'],
    paymentDate: r['Payment Date'],
    checkNumber: r['Check Number'],
    debtorName: r['Debtor Name'],
    feeDays: r['Fee Days'],
    invoiceAmount: r['Invoice Amount'],
    activityType: r['Activity Type'],
    checkAmount: r['Check Amount'],
  }));
}

async function pushPaymentsToAirtable(paymentsMap) {
  const { baseId, tableId, dispatchField, loadField, fieldMap: fm } = CONFIG.airtable;

  if (paymentsMap.size === 0) {
    console.log('[airtable] No payments collected — nothing to push.');
    return;
  }

  // Collect every invoice + load number we might need to look up
  const lookupKeys = new Set();
  for (const r of paymentsMap.values()) {
    if (r.invoiceNo) lookupKeys.add(r.invoiceNo);
    if (r.loadNumber) lookupKeys.add(r.loadNumber);
  }
  const allKeys = Array.from(lookupKeys);

  console.log(`[airtable] Fetching candidates by ${dispatchField} OR ${loadField}...`);
  const [byDispatch, byLoad] = await Promise.all([
    getRecordsByField(baseId, tableId, dispatchField, allKeys),
    getRecordsByField(baseId, tableId, loadField, allKeys),
  ]);

  const candidatesById = new Map();
  for (const r of [...byDispatch, ...byLoad]) candidatesById.set(r.id, r);
  const candidates = Array.from(candidatesById.values());
  console.log(`[airtable] ${candidates.length} candidate record(s) (deduped).`);
  console.log(`[airtable]   - byDispatch: ${byDispatch.length}, byLoad: ${byLoad.length}`);
  if (candidates[0]) {
    console.log(`[airtable]   - sample candidate fields: ${dispatchField}=${JSON.stringify(candidates[0].fields[dispatchField])}, ${loadField}=${JSON.stringify(candidates[0].fields[loadField])}`);
  }

  const updates = [];
  const updatedRecordIds = new Set();
  const unmatchedRows = [];

  for (const payment of paymentsMap.values()) {
    const inv = payment.invoiceNo;
    const load = payment.loadNumber;

    const matches = candidates.filter((c) => {
      const d = String(c.fields[dispatchField] ?? '').trim();
      const l = String(c.fields[loadField] ?? '').trim();
      return (inv && d === inv) || (load && l === load);
    });

    if (matches.length === 0) {
      unmatchedRows.push({
        loadNumber: inv || load,
        customer: payment.debtorName,
        amount: payment.checkAmount ?? payment.invoiceAmount,
        rtsDate: payment.paymentDate || payment.purchaseDate,
        reason: 'Unmatched',
      });
      continue;
    }

    const best = matches[0];
    if (updatedRecordIds.has(best.id)) continue;
    updatedRecordIds.add(best.id);

    const fields = {};
    setIfPresent(fields, fm.paymentDate, payment.paymentDate);
    setIfPresent(fields, fm.checkNumber, payment.checkNumber);
    setIfPresent(fields, fm.activityType, payment.activityType);
    setIfPresent(fields, fm.checkAmount, parseMoney(payment.checkAmount));

    if (Object.keys(fields).length === 0) continue;
    updates.push({ id: best.id, fields });
  }

  console.log(`[airtable] Matched: ${updates.length}, Unmatched: ${unmatchedRows.length}`);

  if (updates.length) {
    console.log(`[airtable] Updating ${updates.length} record(s) with payment date, check #, activity type & check amount...`);
    await updateRecords(baseId, tableId, updates);
    console.log(`[airtable] Update complete.`);
  } else {
    console.log('[airtable] Nothing to update.');
  }

  return { unmatched: unmatchedRows, ambiguous: [] };
}

async function processPaymentsReport(page, context, account, dateRange) {
  ensureDownloadsDir();

  await navigateAuthenticated(page, context, CONFIG.paymentsReportUrl, account);
  await setDateRangeAndView(page, dateRange);

  console.log('[payments] Waiting 8s for the report to render...');
  await page.waitForTimeout(8000);

  const downloadBtn = page.locator(CONFIG.selectors.downloadIcon).first();
  await downloadBtn.waitFor({ state: 'visible', timeout: 15000 });

  console.log('[payments] Clicking download button...');
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await downloadBtn.click();
  const download = await downloadPromise;

  const filePath = path.join(DOWNLOADS_DIR, `payments-${Date.now()}.xlsx`);
  await download.saveAs(filePath);
  console.log(`[payments] Saved: ${filePath}`);

  const rows = parsePaymentsExcel(filePath);
  console.log(`[payments] Parsed ${rows.length} payment row(s).`);

  const paymentsMap = new Map();
  for (const r of rows) {
    const key = r.invoiceNo || r.loadNumber;
    if (key) paymentsMap.set(key, r);
  }

  dumpMap(`[payments] Final Map (${paymentsMap.size} entries):`, paymentsMap);

  return paymentsMap;
}

function parseRecoursedExcel(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

  return rows.map((r) => ({
    status: r['Status'],
    customer: r['Customer'],
    invoiceNo: String(r['Invoice #'] ?? r['Invoice No'] ?? r['Invoice Number'] ?? '').trim(),
    postDate: r['Post Date'],
    invoiceAmount: r['Invoice Amount'],
    recourseDate: r['Recourse Date'],
  }));
}

async function pushRecoursedToAirtable(recoursedMap) {
  const { baseId, tableId, dispatchField, loadField, fieldMap: fm } = CONFIG.airtable;

  if (recoursedMap.size === 0) {
    console.log('[airtable] No recoursed rows collected — nothing to push.');
    return;
  }

  const lookupKeys = Array.from(recoursedMap.keys());

  console.log(`[airtable] Fetching candidates by ${dispatchField} OR ${loadField}...`);
  const [byDispatch, byLoad] = await Promise.all([
    getRecordsByField(baseId, tableId, dispatchField, lookupKeys),
    getRecordsByField(baseId, tableId, loadField, lookupKeys),
  ]);

  const candidatesById = new Map();
  for (const r of [...byDispatch, ...byLoad]) candidatesById.set(r.id, r);
  const candidates = Array.from(candidatesById.values());
  console.log(`[airtable] ${candidates.length} candidate record(s).`);

  const updates = [];
  const updatedRecordIds = new Set();
  const unmatchedRows = [];

  for (const [invoice, row] of recoursedMap) {
    const matches = candidates.filter((c) => {
      const d = String(c.fields[dispatchField] ?? '').trim();
      const l = String(c.fields[loadField] ?? '').trim();
      return d === invoice || l === invoice;
    });

    if (matches.length === 0) {
      unmatchedRows.push({
        loadNumber: invoice,
        customer: row.customer,
        amount: row.invoiceAmount,
        rtsDate: row.recourseDate || row.postDate,
        reason: 'Unmatched',
      });
      continue;
    }

    const best = matches[0];
    if (updatedRecordIds.has(best.id)) continue;
    updatedRecordIds.add(best.id);

    const fields = {};
    setIfPresent(fields, fm.recourseStatus, row.status);
    setIfPresent(fields, fm.recourseDate, row.recourseDate);

    if (Object.keys(fields).length === 0) continue;
    updates.push({ id: best.id, fields });
  }

  console.log(`[airtable] Matched: ${updates.length}, Unmatched: ${unmatchedRows.length}`);

  if (updates.length) {
    console.log(`[airtable] Updating ${updates.length} record(s) with recourse status & date...`);
    await updateRecords(baseId, tableId, updates);
    console.log(`[airtable] Update complete.`);
  } else {
    console.log('[airtable] Nothing to update.');
  }

  return { unmatched: unmatchedRows, ambiguous: [] };
}

async function processRecoursedReport(page, context, account, dateRange) {
  ensureDownloadsDir();

  await navigateAuthenticated(page, context, CONFIG.recoursedReportUrl, account);
  await setDateRangeAndView(page, dateRange);

  console.log('[recoursed] Waiting 8s for the report to render...');
  await page.waitForTimeout(8000);

  const downloadBtn = page.locator(CONFIG.selectors.downloadIcon).first();
  await downloadBtn.waitFor({ state: 'visible', timeout: 15000 });

  console.log('[recoursed] Clicking download button...');
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await downloadBtn.click();
  const download = await downloadPromise;

  const filePath = path.join(DOWNLOADS_DIR, `recoursed-${Date.now()}.xlsx`);
  await download.saveAs(filePath);
  console.log(`[recoursed] Saved: ${filePath}`);

  const rows = parseRecoursedExcel(filePath);
  console.log(`[recoursed] Parsed ${rows.length} recoursed row(s).`);

  const recoursedMap = new Map();
  for (const r of rows) {
    if (r.invoiceNo) recoursedMap.set(r.invoiceNo, r);
  }

  dumpMap(`[recoursed] Final Map (${recoursedMap.size} entries):`, recoursedMap);

  return recoursedMap;
}

function ensureDownloadsDir() {
  if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

async function downloadExcelForRow(page, row, idx) {
  console.log(`[download] Row ${idx + 1}: clicking row...`);
  await row.click().catch(() => {});
  await page.waitForTimeout(400);

  let downloadBtn = row.locator(CONFIG.selectors.downloadIcon).first();
  if ((await downloadBtn.count()) === 0) {
    // Icon may have appeared outside the row after expansion (modal / detail panel)
    downloadBtn = page.locator(CONFIG.selectors.downloadIcon).first();
  }

  console.log(`[download] Row ${idx + 1}: clicking download icon...`);
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await downloadBtn.click();
  const download = await downloadPromise;

  const filePath = path.join(DOWNLOADS_DIR, `purchase-${idx + 1}-${Date.now()}.xlsx`);
  await download.saveAs(filePath);
  console.log(`[download] Saved: ${filePath}`);
  return filePath;
}

async function clickView(page) {
  console.log(`[filter] Clicking View button...`);
  const btn = page.locator(CONFIG.selectors.viewButton).first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
  await page.waitForTimeout(2500);
}

async function setDateRangeAndView(page, range) {
  console.log(`[filter] Setting date range: ${range}`);
  const dateInput = page.locator(CONFIG.selectors.dateRangeInput).first();
  await dateInput.waitFor({ state: 'visible', timeout: 20000 });

  console.log(`[filter] Focusing input...`);
  await dateInput.click();
  await page.waitForTimeout(400);

  console.log(`[filter] Filling value...`);
  await dateInput.fill('');
  await dateInput.fill(range);
  await page.waitForTimeout(300);

  console.log(`[filter] Dismissing any open picker...`);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  await clickView(page);
}

async function goToNextPageIfAvailable(page) {
  const next = page.locator(CONFIG.selectors.paginationNext).first();
  if ((await next.count()) === 0) return false;
  const disabled = await next.isDisabled().catch(() => true);
  if (disabled) return false;
  console.log(`[purchase] Advancing to next page...`);
  await next.click();
  await page.waitForTimeout(2000);
  return true;
}

function parsePurchaseExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  return rows.map((r) => ({
    status: r['Status'],
    invoiceNo: String(r['Invoice #'] ?? r['Invoice No'] ?? r['InvoiceNo'] ?? '').trim(),
    customer: r['Customer'],
    date: r['Date'],
    heldAmount: r['Held Amount'],
    deniedAmount: r['Denied Amount'],
    daysDue: r['Days Due'],
    invoiceAmount: r['Invoice Amount'],
    fee: r['Fee'],
    reserveEscrow: r['Reserve Escrow'],
    fundedAmount: r['Funded Amount'],
  }));
}

async function setRowsPerPage(page, n) {
  console.log(`[filter] Setting rows per page to ${n}...`);
  try {
    const dropdown = page.locator(CONFIG.selectors.rowsPerPageDropdown).last();
    if ((await dropdown.count()) === 0) {
      console.log('[filter] Rows-per-page dropdown not found — leaving default.');
      return false;
    }
    await dropdown.click();
    await page.waitForTimeout(500);

    const option = page.locator(`li[data-value="${n}"], li[role="option"]:has-text("${n}")`).first();
    await option.waitFor({ state: 'visible', timeout: 5000 });
    await option.click();
    await page.waitForTimeout(2000);
    console.log(`[filter] Rows per page set to ${n}.`);
    return true;
  } catch (err) {
    console.log(`[filter] Could not set rows per page automatically: ${err.message}`);
    return false;
  }
}

async function ingestExcelIntoMap(filePath, purchaseMap) {
  const parsed = parsePurchaseExcel(filePath);
  for (const r of parsed) {
    const key = String(r.invoiceNo).trim();
    if (key) purchaseMap.set(key, r);
  }
}

async function readRowInvoiceNumber(row) {
  const cell = row.locator(CONFIG.selectors.rowInvoiceCell).first();
  const text = await cell.innerText().catch(() => '');
  return text.trim();
}

async function clickViewAndWait(page) {
  const btn = page.locator(CONFIG.selectors.viewButton).first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
  // Wait for the table rows to actually render before continuing
  await page
    .locator(CONFIG.selectors.purchaseRow)
    .first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => {});
  await page.waitForTimeout(1500);
}

async function downloadOneRow(page, idx, purchaseMap) {
  const rows = page.locator(CONFIG.selectors.purchaseRow);
  const row = rows.nth(idx);

  const rowInvoice = await readRowInvoiceNumber(row);
  if (rowInvoice && purchaseMap.has(rowInvoice)) return;

  let downloadBtn = row.locator(CONFIG.selectors.downloadIcon).first();
  let expanded = false;

  if (!(await downloadBtn.isVisible().catch(() => false))) {
    await row.click();
    await page.waitForTimeout(300);
    expanded = true;
    downloadBtn = page.locator(CONFIG.selectors.downloadIcon).first();
    await downloadBtn.waitFor({ state: 'visible', timeout: 10000 });
  }

  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await downloadBtn.click();
  const download = await downloadPromise;

  const filePath = path.join(DOWNLOADS_DIR, `purchase-${idx + 1}-${Date.now()}.xlsx`);
  await download.saveAs(filePath);
  await ingestExcelIntoMap(filePath, purchaseMap);

  if (expanded) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  }
}

async function downloadAllRowsSequential(page, purchaseMap) {
  const total = await page.locator(CONFIG.selectors.purchaseRow).count();

  for (let i = 0; i < total; i++) {
    // Re-check current row count — the list may have re-rendered with fewer rows after a View click
    const currentTotal = await page.locator(CONFIG.selectors.purchaseRow).count();
    if (i >= currentTotal) {
      console.log(`Row ${i + 1} not present (current count: ${currentTotal}) — stopping.`);
      break;
    }

    try {
      await downloadOneRow(page, i, purchaseMap);
      if (CONFIG.verbose) console.log(`[map]`, Object.fromEntries(purchaseMap));
      else console.log(`[purchase] Row ${i + 1}/${total} done — ${purchaseMap.size} invoice(s) collected.`);
    } catch (err) {
      console.error(`Row ${i + 1} failed:`, err.message);
    }

    if (i < total - 1) {
      await clickViewAndWait(page);
    }
  }
}

async function processPurchaseReport(page, context, account, dateRange) {
  ensureDownloadsDir();

  await navigateAuthenticated(page, context, CONFIG.purchaseReportUrl, account);
  await setDateRangeAndView(page, dateRange);
  await setRowsPerPage(page, CONFIG.rowsPerPage);

  const purchaseMap = new Map();
  await downloadAllRowsSequential(page, purchaseMap);

  dumpMap(`\n[map] Final purchase Map (${purchaseMap.size} entries):`, purchaseMap);

  return purchaseMap;
}

async function runForAccount(account, dateRange) {
  console.log(`\n=== Starting run for ${account.name} | range: ${dateRange} ===`);

  if (!account.user || !account.pass) {
    throw new Error(`Missing env vars for ${account.name}. Set credentials in .env first.`);
  }

  const { browser, context, page } = await launchBrowser(account.authFile);

  try {
    await navigateAuthenticated(page, context, CONFIG.loginUrl, account);

    const purchaseMap = await processPurchaseReport(page, context, account, dateRange);
    console.log(`\n[summary] ${account.name}: ${purchaseMap.size} purchases collected.`);

    const result = await pushPurchasesToAirtable(purchaseMap);
    if (result) {
      await pushUnresolvedToAirtable('Purchases', account, [...result.unmatched, ...result.ambiguous]);
    }

    await saveSession(context, 'end-of-run', account.authFile);
    if (!CONFIG.autoClose) {
      await waitForEnter(`\n>>> ${account.name} done. Press ENTER to close the browser...\n`);
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function runRTSDefault(dateRange) {
  await runForAccount(ACCOUNTS.default, dateRange);
}

export async function runRTSChandi(dateRange) {
  await runForAccount(ACCOUNTS.chandi, dateRange);
}

export async function runRTS313(dateRange) {
  await runForAccount(ACCOUNTS['313'], dateRange);
}

async function runPaymentsForAccount(account, dateRange) {
  console.log(`\n=== Payments run for ${account.name} | range: ${dateRange} ===`);

  if (!account.user || !account.pass) {
    throw new Error(`Missing env vars for ${account.name}. Set credentials in .env first.`);
  }

  const { browser, context, page } = await launchBrowser(account.authFile);

  try {
    await navigateAuthenticated(page, context, CONFIG.loginUrl, account);

    const paymentsMap = await processPaymentsReport(page, context, account, dateRange);
    console.log(`\n[summary] ${account.name}: ${paymentsMap.size} payments collected.`);

    const result = await pushPaymentsToAirtable(paymentsMap);
    if (result) {
      await pushUnresolvedToAirtable('Payments', account, [...result.unmatched, ...result.ambiguous]);
    }

    await saveSession(context, 'end-of-run', account.authFile);
    if (!CONFIG.autoClose) {
      await waitForEnter(`\n>>> ${account.name} payments done. Press ENTER to close the browser...\n`);
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function runPaymentsRTSDefault(dateRange) {
  await runPaymentsForAccount(ACCOUNTS.default, dateRange);
}

export async function runPaymentsRTSChandi(dateRange) {
  await runPaymentsForAccount(ACCOUNTS.chandi, dateRange);
}

export async function runPaymentsRTS313(dateRange) {
  await runPaymentsForAccount(ACCOUNTS['313'], dateRange);
}

async function runRecoursedForAccount(account, dateRange) {
  console.log(`\n=== Recoursed run for ${account.name} | range: ${dateRange} ===`);

  if (!account.user || !account.pass) {
    throw new Error(`Missing env vars for ${account.name}. Set credentials in .env first.`);
  }

  const { browser, context, page } = await launchBrowser(account.authFile);

  try {
    await navigateAuthenticated(page, context, CONFIG.loginUrl, account);

    const recoursedMap = await processRecoursedReport(page, context, account, dateRange);
    console.log(`\n[summary] ${account.name}: ${recoursedMap.size} recoursed rows collected.`);

    const result = await pushRecoursedToAirtable(recoursedMap);
    if (result) {
      await pushUnresolvedToAirtable('Recoursed', account, [...result.unmatched, ...result.ambiguous]);
    }

    await saveSession(context, 'end-of-run', account.authFile);
    if (!CONFIG.autoClose) {
      await waitForEnter(`\n>>> ${account.name} recoursed done. Press ENTER to close the browser...\n`);
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function runRecoursedRTSDefault(dateRange) {
  await runRecoursedForAccount(ACCOUNTS.default, dateRange);
}

export async function runRecoursedRTSChandi(dateRange) {
  await runRecoursedForAccount(ACCOUNTS.chandi, dateRange);
}

export async function runRecoursedRTS313(dateRange) {
  await runRecoursedForAccount(ACCOUNTS['313'], dateRange);
}

const DATE_RANGE = '02/01/2026 – 02/28/2026';

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  // === PURCHASES (writes 6 RTS amount fields per matched row) ===
  // Run one at a time: keep ONE line uncommented, run `npm run dev`, then swap to the next.
  runRTSDefault(DATE_RANGE).catch((err) => { console.error('Fatal error:', err); process.exit(1); });
  // runRTSChandi(DATE_RANGE).catch((err) => { console.error('Fatal error:', err); process.exit(1); });
  // runRTS313(DATE_RANGE).catch((err) => { console.error('Fatal error:', err); process.exit(1); });

  // === PAYMENTS (writes RTS Payment Date + RTS Check Number) ===
  // runPaymentsRTSDefault(DATE_RANGE).catch((err) => { console.error('Fatal error:', err); process.exit(1); });
  // runPaymentsRTSChandi(DATE_RANGE).catch((err) => { console.error('Fatal error:', err); process.exit(1); });
  // runPaymentsRTS313(DATE_RANGE).catch((err) => { console.error('Fatal error:', err); process.exit(1); });

  // === RECOURSED (writes RTS Recourse Status + RTS Recourse Date) ===
  // runRecoursedRTSDefault(DATE_RANGE).catch((err) => { console.error('Fatal error:', err); process.exit(1); });
  // runRecoursedRTSChandi(DATE_RANGE).catch((err) => { console.error('Fatal error:', err); process.exit(1); });
  // runRecoursedRTS313(DATE_RANGE).catch((err) => { console.error('Fatal error:', err); process.exit(1); });
}
