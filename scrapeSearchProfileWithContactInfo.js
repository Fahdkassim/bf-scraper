import fs from 'fs-extra';
import path from 'path';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createObjectCsvWriter } from 'csv-writer';
import selectors from './selectors.config.js';
import 'dotenv/config';
import {
  namesBatch1,
  namesBatch2,
  namesBatch3,
  namesBatch4,
  namesBatch5,
  namesBatch6,
  namesBatch7,
  namesBatch8,
  namesBatch9,
} from './searchNamesList.js';

puppeteerExtra.use(StealthPlugin());

const START_URL = 'https://benefit-flow.com/Search';
const OUTPUT_JSON = path.join('output', 'data.json');
const OUTPUT_CSV = path.join('output', 'data.csv');

const BROKER_NAMES = namesBatch9;
const companyNameFilter = ['lockton', 'aetna', 'onedigital', 'Alera'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickByText(page, text) {
  await page.evaluate((t) => {
    const elements = Array.from(
      document.querySelectorAll('p, div, span, button')
    );
    const el = elements.find((e) => e.innerText.trim() === t.trim());
    if (el) el.click();
  }, text);
}

async function autoLogin(page) {
  const USERNAME = process.env.BF_USERNAME;
  const PASSWORD = process.env.BF_PASSWORD;

  if (!USERNAME || !PASSWORD)
    throw new Error('❌ BF_USERNAME or BF_PASSWORD not set in .env');

  console.log('🚀 Performing Cognito login...');
  await sleep(2000);

  let loginFrame = page;
  const frames = page.frames();
  const cognitoFrame = frames.find((f) => f.url().includes('cognito'));
  if (cognitoFrame) loginFrame = cognitoFrame;

  await loginFrame.waitForSelector('form[name="cognitoSignInForm"]', {
    timeout: 60000,
  });

  await loginFrame.evaluate(
    async (username, password) => {
      const unameInput = document.querySelector('#signInFormUsername');
      const pwdInput = document.querySelector('#signInFormPassword');
      if (!unameInput || !pwdInput) throw new Error('Login inputs not found!');

      const slowType = async (input, text) => {
        input.focus();
        for (let char of text) {
          input.value += char;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 150));
        }
      };

      await slowType(unameInput, username);
      await slowType(pwdInput, password);
      document.querySelector('form[name="cognitoSignInForm"]').submit();
    },
    USERNAME,
    PASSWORD
  );

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
  console.log('✅ Cognito login successful');
}

async function searchBroker(page, brokerName) {
  const searchInputSelector = 'input[placeholder="Search broker contacts"]';
  console.log(`\n🔎 Searching for: ${brokerName}`);

  await page.waitForSelector(searchInputSelector, { timeout: 30000 });
  const input = await page.$(searchInputSelector);

  await input.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');

  await input.type(brokerName, { delay: 80 });
  await page.keyboard.press('Enter');

  await sleep(2000);
}

/* -------------------------------------------------------
   🔥 APPLY COMPANY NAME FILTER
------------------------------------------------------- */

async function applyCompanyNameFilter(page, companyName) {
  console.log(`Applying Company Name Filter: ${companyName}`);

  // Expand the Company Name collapsible
  await page.evaluate(() => {
    const sections = Array.from(document.querySelectorAll('.ds_collapsible'));
    const companySection = sections.find((sec) =>
      sec.innerText.includes('Company Name')
    );
    if (companySection && companySection.classList.contains('closed')) {
      companySection.querySelector('.ds_collapsible-button')?.click();
    }
  });

  await new Promise((res) => setTimeout(res, 700));

  const inputSelector =
    '.ds_collapsible input.ds_input[placeholder="e.g. Mercer"]';
  await page.waitForSelector(inputSelector, { timeout: 10000 });

  await page.focus(inputSelector);
  await page.click(inputSelector, { clickCount: 3 });
  await page.keyboard.press('Backspace');

  // Type company name
  await page.type(inputSelector, companyName, { delay: 50 });

  await sleep(2000);

  // ✅ Wait for autocomplete dropdown to appear
  const dropdownSelector =
    '[data-testid^="auto-complete-component-options"]:not(.hidden)';
  await page.waitForSelector(dropdownSelector, { timeout: 5000 });

  await sleep(2000);
  // Press Enter AFTER dropdown appears
  await page.keyboard.press('Enter');

  // Wait for cards to appear
  await page.waitForFunction(
    () =>
      document.querySelectorAll('div[data-testid="card-container"]').length > 0,
    { timeout: 15000 }
  );

  console.log(`✔ Company Name filter applied successfully: ${companyName}`);
}

async function scrapePage(page) {
  const items = await page.$$('[data-testid="card-container"]');
  const results = [];

  for (const card of items) {
    try {
      const getContactHandle = await card.evaluateHandle((cardEl) => {
        return (
          Array.from(cardEl.querySelectorAll('button')).find(
            (b) => b.innerText.trim() === 'Get Contact'
          ) || null
        );
      });

      if (getContactHandle) {
        const getContactBtn = getContactHandle.asElement();
        if (getContactBtn) {
          await getContactBtn.click();
          await card
            .waitForSelector(
              'p[data-testid="visible-phone"], p[data-testid="visible-email"]',
              { timeout: 5000 }
            )
            .catch(() => {});
          await sleep(500);
        }
      }

      // Scrape card content
      const data = await card.evaluate((cardEl) => {
        const brokerCol = cardEl.children[0];
        const companyCol = cardEl.children[1];

        const name =
          brokerCol
            .querySelector('[data-testid="card-title"]')
            ?.innerText?.trim() || null;
        const title =
          brokerCol
            .querySelector('p.ds_typography-text.sm.regular')
            ?.innerText?.trim() || null;
        const location =
          brokerCol
            .querySelectorAll('p.ds_typography-text.sm.regular')[1]
            ?.innerText?.trim() || null;
        const linkedin_profile =
          brokerCol.querySelector('a[href*="linkedin.com/in"]')?.href || null;
        const avatar = brokerCol.querySelector('img.ds_avatar')?.src || null;

        const company =
          companyCol
            .querySelector('[data-testid="card-title"]')
            ?.innerText?.trim() || null;
        const linkedin_company =
          companyCol.querySelector('a[href*="linkedin.com/company"]')?.href ||
          null;

        const phone =
          cardEl
            .querySelector('p[data-testid="visible-phone"]')
            ?.innerText?.trim() || null;
        const email =
          cardEl
            .querySelector('p[data-testid="visible-email"]')
            ?.innerText?.trim() || null;

        const descLabels = cardEl.querySelectorAll(
          '[data-testid="description-label"]'
        );
        const descValues = cardEl.querySelectorAll(
          '[data-testid="description-value"]'
        );

        let yearsInRole = null;
        let yearsAtCompany = null;

        descLabels.forEach((label, idx) => {
          const txt = label.innerText?.trim().toLowerCase();
          if (txt.includes('yrs. in role'))
            yearsInRole = descValues[idx]?.innerText?.trim() || null;
          if (txt.includes('yrs. at company'))
            yearsAtCompany = descValues[idx]?.innerText?.trim() || null;
        });

        return {
          name,
          title,
          location,
          phone,
          email,
          linkedin_profile,
          company,
          linkedin_company,
          avatar,
          yearsInRole,
          yearsAtCompany,
        };
      }, card);

      results.push(data);
    } catch (err) {
      console.error('❌ Failed to scrape a card:', err.message);
    }
  }

  return results.filter((item) => item.name || item.company);
}

async function searchAndScrapeForName(page, name, csvWriter, aggregated) {
  await searchBroker(page, name);
  await sleep(3000);

  const cards = await page.$$(selectors.card);
  if (cards.length === 0) {
    console.log(`❌ No results found for: ${name}`);
    return aggregated;
  }

  console.log(`Found ${cards.length} result(s) for: ${name}`);
  const results = await scrapePage(page);

  if (results.length > 0) {
    console.log(`📦 Saved ${results.length} item(s) for: ${name}`);
    aggregated.push(...results);
    await csvWriter.writeRecords(results);
  } else {
    console.log(`⚠️ No data scraped for: ${name}`);
  }

  return aggregated;
}

async function main() {
  await fs.ensureDir('output');

  const browser = await puppeteerExtra.launch({
    headless: false,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  await page.goto(START_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await autoLogin(page);
  await sleep(3000);

  console.log('Opening Broker Contacts tab...');
  await clickByText(page, selectors.brokerTabText);
  await page.waitForSelector(selectors.card);
  await sleep(2000);

  // CSV writer always writes headers if file doesn't exist or is empty
  const csvWriter = createObjectCsvWriter({
    path: OUTPUT_CSV,
    header: [
      { id: 'name', title: 'Name' },
      { id: 'title', title: 'Title' },
      { id: 'location', title: 'Location' },
      { id: 'phone', title: 'Phone' },
      { id: 'email', title: 'Email' },
      { id: 'company', title: 'Company' },
      { id: 'linkedin_profile', title: 'LinkedIn Profile' },
      { id: 'linkedin_company', title: 'Company LinkedIn' },
      { id: 'avatar', title: 'Avatar URL' },
      { id: 'yearsInRole', title: 'Years in Role' },
      { id: 'yearsAtCompany', title: 'Years at Company' },
    ],
    append: fs.existsSync(OUTPUT_CSV) && (await fs.stat(OUTPUT_CSV)).size > 0,
  });
  await sleep(1000);
  for (const company of companyNameFilter) {
    await applyCompanyNameFilter(page, company);
    await sleep(1000);
  }
  await sleep(3000);
  let aggregated = [];
  for (const name of BROKER_NAMES) {
    aggregated = await searchAndScrapeForName(
      page,
      name,
      csvWriter,
      aggregated
    );
    console.log('--- Moving to next broker ---\n');
    await sleep(2000);
  }

  await fs.writeJson(OUTPUT_JSON, aggregated, { spaces: 2 });
  console.log('🎉 Completed all names.');

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
