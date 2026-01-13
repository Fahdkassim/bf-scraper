import fs from 'fs-extra';
import path from 'path';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import selectors from './selectors.config.js';
import 'dotenv/config';

puppeteerExtra.use(StealthPlugin());

const START_URL = 'https://benefit-flow.com/Search';
const OUTPUT_JSON = path.join('output', 'data.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickByText(page, text) {
  await page.evaluate((t) => {
    const els = Array.from(document.querySelectorAll('p,div,span,button'));
    const el = els.find((e) => e.innerText.trim() === t.trim());
    if (el) el.click();
  }, text);
}

/* ---------------- LOGIN ---------------- */

async function autoLogin(page) {
  const USERNAME = process.env.BF_USERNAME;
  const PASSWORD = process.env.BF_PASSWORD;
  if (!USERNAME || !PASSWORD) throw new Error('Missing BF credentials in .env');

  console.log('🚀 Logging in...');
  await sleep(1500);

  let loginFrame = page;
  const cognitoFrame = page.frames().find((f) => f.url().includes('cognito'));
  if (cognitoFrame) loginFrame = cognitoFrame;

  await loginFrame.waitForSelector('form[name="cognitoSignInForm"]');

  await loginFrame.evaluate(
    async (u, p) => {
      const uEl = document.querySelector('#signInFormUsername');
      const pEl = document.querySelector('#signInFormPassword');

      const slowType = async (el, txt) => {
        el.focus();
        for (const c of txt) {
          el.value += c;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 120));
        }
      };

      await slowType(uEl, u);
      await slowType(pEl, p);
      document.querySelector('form[name="cognitoSignInForm"]').submit();
    },
    USERNAME,
    PASSWORD
  );

  await page.waitForNavigation({ waitUntil: 'networkidle2' });
  console.log('✅ Login successful');
}

/* ---------------- COMPANY FILTER ---------------- */

async function applyCompanyNameFilter(page, companyName) {
  console.log(`✔ Applying company filter: ${companyName}`);

  await page.evaluate(() => {
    const sec = [...document.querySelectorAll('.ds_collapsible')].find((s) =>
      s.innerText.includes('Company Name')
    );
    if (sec && sec.classList.contains('closed'))
      sec.querySelector('.ds_collapsible-button')?.click();
  });

  await sleep(500);

  const input = '.ds_collapsible input.ds_input[placeholder="e.g. Mercer"]';
  await page.waitForSelector(input);

  await page.click(input, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(input, companyName, { delay: 40 });

  const dropdown =
    '[data-testid^="auto-complete-component-options"]:not(.hidden)';
  await page.waitForSelector(dropdown);
  await sleep(500);
  await page.keyboard.press('Enter');

  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="card-container"]').length > 0
  );
}

/* ---------------- SEARCH ---------------- */

async function searchBroker(page, brokerName) {
  const inputSel = 'input[placeholder="Search broker contacts"]';

  console.log(`🔎 Searching: ${brokerName}`);
  await page.waitForSelector(inputSel);

  await page.click(inputSel, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(inputSel, brokerName, { delay: 60 });
  await page.keyboard.press('Enter');

  await sleep(2000);
}

/* ---------------- SCRAPE ---------------- */

async function scrapePage(page) {
  const cards = await page.$$('[data-testid="card-container"]');
  const results = [];

  for (const card of cards) {
    try {
      const data = await card.evaluate((cardEl) => {
        const b = cardEl.children[0];
        const c = cardEl.children[1];

        const name =
          b.querySelector('[data-testid="card-title"]')?.innerText.trim() ||
          null;
        const title =
          b
            .querySelector('p.ds_typography-text.sm.regular')
            ?.innerText.trim() || null;
        const location =
          b
            .querySelectorAll('p.ds_typography-text.sm.regular')[1]
            ?.innerText.trim() || null;
        const linkedin_profile =
          b.querySelector('a[href*="linkedin.com/in"]')?.href || null;
        const avatar = b.querySelector('img.ds_avatar')?.src || null;

        const company =
          c.querySelector('[data-testid="card-title"]')?.innerText.trim() ||
          null;
        const linkedin_company =
          c.querySelector('a[href*="linkedin.com/company"]')?.href || null;

        const phone =
          cardEl
            .querySelector('[data-testid="visible-phone"]')
            ?.innerText.trim() || null;
        const email =
          cardEl
            .querySelector('[data-testid="visible-email"]')
            ?.innerText.trim() || null;

        return {
          name,
          title,
          location,
          phone,
          email,
          company,
          linkedin_profile,
          linkedin_company,
          avatar,
        };
      });

      results.push(data);
    } catch {}
  }

  return results.filter((r) => r.name || r.company);
}

/* ---------------- MAIN WORKER ---------------- */

async function searchAndScrape(page, brokerNames) {
  let aggregated = [];

  for (const name of brokerNames) {
    await searchBroker(page, name);

    const cards = await page.$$('[data-testid="card-container"]');
    if (!cards.length) {
      console.log(`❌ No results: ${name}`);
      continue;
    }

    const data = await scrapePage(page);
    if (data.length) {
      aggregated.push(...data);
      console.log(`📦 Saved ${data.length} for ${name}`);
    }
  }

  return aggregated;
}

/* ---------------- PUBLIC ENTRY ---------------- */

export async function runSearchScraper(filters = {}) {
  await fs.ensureDir('output');

  const { brokerNames = [], companyNames = [] } = filters;

  if (!brokerNames.length) throw new Error('brokerNames[] is required');

  const browser = await puppeteerExtra.launch({
    headless: true,
    args: ['--no-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  await page.goto(START_URL, { waitUntil: 'networkidle2' });
  await autoLogin(page);

  await clickByText(page, selectors.brokerTabText);
  await page.waitForSelector(selectors.card);
  await sleep(1500);

  // Apply company filters
  if (Array.isArray(companyNames)) {
    for (const c of companyNames) {
      await applyCompanyNameFilter(page, c);
      await sleep(800);
    }
  }

  const data = await searchAndScrape(page, brokerNames);

  await fs.writeJson(OUTPUT_JSON, data, { spaces: 2 });

  await browser.close();
  console.log('🎉 Search scraper completed');

  return data;
}

/* ---------------- OPTIONAL DIRECT RUN ---------------- */

if (import.meta.url === `file://${process.argv[1]}`) {
  runSearchScraper({
    brokerNames: ['John Smith', 'Sarah Adams'],
    companyNames: ['Alera', 'Lockton'],
  }).catch(console.error);
}
