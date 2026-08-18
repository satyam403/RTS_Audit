/**
 * Interactive login helper — the one step that genuinely needs a human.
 *
 * Opens a real browser, clears the pre-auth gates, submits the credentials, and
 * ticks "Remember this device for 30 days" on the SMS screen. You type the code
 * in the browser — there is no terminal prompt, the script watches the URL and
 * carries on by itself. Touches nothing in Airtable.
 *
 *   npm run login            # all three accounts, one after another
 *   npm run login default
 *   npm run login chandi 313
 *
 * With --auto it stays headless and never waits: useful for checking whether a
 * saved session still works. An account sitting behind SMS is reported as
 * needing the normal (browser) run.
 *
 *   npm run login -- --auto
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACCOUNTS, CONFIG, autofillLogin, gotoStable } from './index.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const AUTO = argv.includes('--auto');
const HEADFUL = argv.includes('--show'); // watch the browser even in --auto
const WAIT_MINUTES = Number(process.env.LOGIN_WAIT_MIN || 10);
const requested = argv.filter((a) => !a.startsWith('-'));
const keys = requested.length ? requested : Object.keys(ACCOUNTS);

const unknown = keys.filter((k) => !ACCOUNTS[k]);
if (unknown.length) {
  console.error(`Unknown account(s): ${unknown.join(', ')}`);
  console.error(`Valid: ${Object.keys(ACCOUNTS).join(', ')}`);
  process.exit(1);
}

/**
 * Tick "Remember this device for 30 days" on the MFA screen. Auth0 skins this
 * differently across tenants, so try the label, then the raw checkbox.
 */
async function tickRememberDevice(page) {
  const attempts = [
    () => page.getByLabel(/remember this device/i).first(),
    () => page.locator('label:has-text("Remember this device")').first(),
    () => page.locator('input[type="checkbox"]').first(),
  ];

  for (const build of attempts) {
    try {
      const el = build();
      if (!(await el.isVisible({ timeout: 2000 }).catch(() => false))) continue;
      if (await el.isChecked().catch(() => false)) return true;
      await el.check({ timeout: 5000 }).catch(async () => { await el.click({ timeout: 5000 }); });
      if (await page.locator('input[type="checkbox"]').first().isChecked().catch(() => false)) return true;
    } catch {
      /* try the next shape */
    }
  }
  return false;
}

/**
 * Wait for the human to finish the SMS challenge *in the browser*, by watching
 * the URL rather than asking them to come back and press ENTER in a terminal.
 * Purely passive — it never navigates while they're mid-code.
 */
async function waitForHumanToClearAuth(page, minutes = 10) {
  const deadline = Date.now() + minutes * 60_000;
  let lastUrl = '';

  while (Date.now() < deadline) {
    const url = page.url();
    if (url !== lastUrl) {
      console.log(`  ...at ${url.split('?')[0]}`);
      lastUrl = url;
    }
    if (!/auth\.rtspro\.com|\/u\/login|\/authorize|\/mfa/i.test(url)) return true;

    if (page.isClosed()) {
      console.error('  Browser was closed before the login finished.');
      return false;
    }
    await page.waitForTimeout(3000);
  }

  console.error(`  Timed out after ${minutes} min waiting for the code.`);
  return false;
}

/**
 * Record when device-trust was last established, so the nightly job can warn
 * before the 30 days run out instead of just failing one morning.
 */
function markVerified(key) {
  const file = path.join(ROOT, `.mfa-${key}.json`);
  fs.writeFileSync(file, JSON.stringify({ verifiedAt: new Date().toISOString() }, null, 2));
}

async function loginOne(key) {
  const account = ACCOUNTS[key];
  const authFile = path.join(ROOT, account.authFile);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${account.name}  (${key})`);
  console.log('='.repeat(60));

  if (!account.user || !account.pass) {
    console.error(`  SKIPPED — credentials missing in .env for ${account.name}.`);
    return false;
  }

  const browser = await chromium.launch({ headless: AUTO && !HEADFUL });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: CONFIG.viewport,
    permissions: ['geolocation'],
    geolocation: { latitude: 39.0997, longitude: -94.5786 },
  });
  await context.grantPermissions(['geolocation'], { origin: 'https://rtspro.com' });
  const page = await context.newPage();

  try {
    await gotoStable(page, CONFIG.loginUrl);

    try {
      // Shared with the nightly job so both clear the same pre-auth gates.
      await autofillLogin(page, account);
      console.log('  Credentials submitted.');
    } catch (err) {
      console.log(`  Could not autofill (already logged in, or the form changed): ${err.message}`);
    }

    if (AUTO) {
      await page
        .waitForURL((u) => !/auth\.rtspro\.com|\/u\/login|\/authorize/i.test(u.toString()), { timeout: 45000 })
        .catch(() => {});
      await page.waitForTimeout(4000);

      if (/mfa/i.test(page.url())) {
        console.error('  SMS CODE REQUIRED — no automation can clear this.');
        console.error(`  Run interactively:  npm run login ${key}`);
        return false;
      }

      // Landing on rtspro.com proves nothing — the marketing shell renders for
      // signed-out visitors too. Only a real report page counts as proof.
      console.log('  Verifying against the purchase report page...');
      await gotoStable(page, CONFIG.purchaseReportUrl, 6000).catch(() => {});

      const reachedApp = await page
        .locator(CONFIG.selectors.dateRangeInput)
        .first()
        .isVisible()
        .catch(() => false);

      if (!reachedApp) {
        const shot = path.join(ROOT, 'downloads', `login-blocked-${key}-${Date.now()}.png`);
        fs.mkdirSync(path.dirname(shot), { recursive: true });
        await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
        console.error(`  NOT LOGGED IN — stopped at ${page.url()}`);
        console.error(`  Screenshot: ${shot}`);
        if (text.trim()) console.error(`  Page says: ${text.replace(/\s+/g, ' ')}`);
        return false;
      }

      console.log(`  Verified — report page loaded at ${page.url()}`);
      await context.storageState({ path: authFile });
      markVerified(key);
      console.log(`  Saved ${account.authFile} (${fs.statSync(authFile).size} bytes).`);
      return true;
    }

    // --- MFA -------------------------------------------------------------
    // RTS texts a 6-digit code. The "Remember this device for 30 days" box is
    // the whole point of this script: ticking it is what buys the nightly job
    // a month of unattended runs. Never leave it to chance.
    await page.waitForTimeout(4000);
    const onMfa = /mfa/i.test(page.url()) ||
      (await page.locator('text=/verify your identity/i').first().isVisible().catch(() => false));

    if (onMfa) {
      const ticked = await tickRememberDevice(page);
      console.log('\n  ' + '*'.repeat(66));
      console.log(`  *  ${account.name}: RTS has texted a 6-digit code.`);
      console.log('  *  TYPE IT IN THE BROWSER WINDOW and submit.');
      console.log(ticked
        ? '  *  "Remember this device for 30 days" is already CHECKED — good for ~30 days.'
        : '  *  WARNING: could not auto-check "Remember this device for 30 days".\n'
          + '  *  TICK IT YOURSELF, or you will re-enter a code every night.');
      console.log('  ' + '*'.repeat(66) + '\n');
    } else {
      console.log('\n  No SMS challenge — finish anything else the browser asks for.');
    }

    // No terminal prompt: watching the URL means the operator only ever has to
    // touch the browser, which is also what lets this be driven remotely.
    if (!(await waitForHumanToClearAuth(page, WAIT_MINUTES))) return false;
    console.log('  Auth cleared.');

    // Same proof as --auto: the marketing shell renders for signed-out visitors.
    console.log('  Verifying against the purchase report page...');
    await gotoStable(page, CONFIG.purchaseReportUrl, 6000).catch(() => {});
    const reachedApp = await page.locator(CONFIG.selectors.dateRangeInput).first().isVisible().catch(() => false);

    if (!reachedApp) {
      console.error(`  NOT LOGGED IN — the report page did not load (${page.url()}).`);
      console.error('  Nothing was saved. Try again.');
      return false;
    }

    await context.storageState({ path: authFile });
    markVerified(key);
    console.log(`  Verified & saved ${account.authFile} (${fs.statSync(authFile).size} bytes).`);
    return true;
  } finally {
    await context.close();
    await browser.close();
  }
}

const saved = [];
const skipped = [];

for (const key of keys) {
  try {
    if (await loginOne(key)) saved.push(key);
    else skipped.push(key);
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    skipped.push(key);
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Sessions saved: ${saved.length ? saved.join(', ') : 'none'}`);
if (skipped.length) console.log(`Not saved:      ${skipped.join(', ')}`);
console.log('='.repeat(60));
console.log('\nNext: npm run schedule:install');

process.exit(skipped.length ? 1 : 0);
