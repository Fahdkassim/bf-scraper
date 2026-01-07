import fs from 'fs-extra';
import path from 'path';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createObjectCsvWriter } from 'csv-writer';
import selectors from './selectors.config.js';
import 'dotenv/config';

puppeteerExtra.use(StealthPlugin());

const START_URL = 'https://benefit-flow.com/Search';
const OUTPUT_JSON = path.join('output', 'data.json');
const OUTPUT_CSV = path.join('output', 'data.csv');

// ---- ARRAY OF BROKER NAMES ----
const BROKER_NAMES = [
  'Ruth Loregio',
  'Kim Greenberg',
  'Meghan Pugh',
  'Robin Bouvier',
  'Kimberly Lewis',
  'Kristin Lesniewski',
  'Lindsey Jacobsen',
  'Laura Denton',
  'Rebecca Rapoport',
  'Jessica Seniuk',
  'Josh Gunther',
  'Emily Johnson',
  'Jessica Wachter',
  'Jill Ruggiero',
  'Cecelia Gallagher',
  'Linda Hubbard',
  'Amanda Herb',
  'Jonathan Lamb',
  'Melissa Meadows',
  'Alyssa Thomas',
  'Jennifer Lechman',
  'Mary Ward',
  'Samantha Winter',
  'Adam Ulincy',
  'Courtney Maron',
  'Victoria Rinehart',
  'Anna Nguyen',
  'Jean Chambers',
  'Brianna Roberts',
  'Chris Viesselman',
  'John Salvador',
  'Meghan Richards',
  'Rachel Ratko',
];

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

  if (!USERNAME || !PASSWORD) {
    throw new Error('❌ BF_USERNAME or BF_PASSWORD not set in .env');
  }

  console.log('🚀 Performing Cognito login...');
  await sleep(2000);

  // Check for iframe
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

      // Helper to type slowly
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

async function waitForLogin(page, checkSelector, timeout = 300_000) {
  console.log('Please log in manually...');
  try {
    await page.waitForSelector(checkSelector, { timeout });
    console.log('Login detected! Search page loaded.');
  } catch (err) {
    throw new Error('Timeout waiting for login/search page.');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------------
// BROKER SEARCH FUNCTION
// -------------------------------------------------------
async function searchBroker(page, brokerName) {
  const searchInputSelector = 'input[placeholder="Search broker contacts"]';

  console.log(`\n🔎 Searching for: ${brokerName}`);

  await page.waitForSelector(searchInputSelector, { timeout: 30000 });

  const input = await page.$(searchInputSelector);

  // Clear previous text
  await input.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');

  // Type new name
  await input.type(brokerName, { delay: 80 });
  await page.keyboard.press('Enter');

  await sleep(2000);
}

/* -------------------------------------------------------
   SCRAPE PAGE
------------------------------------------------------- */
async function scrapePage(page) {
  const items = await page.$$eval(
    'div[data-testid="card-container"]',
    (cards) => {
      return cards.map((card) => {
        const brokerCol = card.children[0];
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

        const companyCol = card.children[1];
        const company =
          companyCol
            .querySelector('[data-testid="card-title"]')
            ?.innerText?.trim() || null;
        const linkedin_company =
          companyCol.querySelector('a[href*="linkedin.com/company"]')?.href ||
          null;

        const email =
          card
            .querySelector('[data-testid="visible-email"]')
            ?.innerText?.trim() || null;

        const descValues = card.querySelectorAll(
          '[data-testid="description-value"]'
        );
        const descLabels = card.querySelectorAll(
          '[data-testid="description-label"]'
        );

        let yearsInRole = null;
        let yearsAtCompany = null;

        descLabels.forEach((label, idx) => {
          const txt = label.innerText?.trim().toLowerCase();
          if (txt.includes('yrs. in role')) {
            yearsInRole = descValues[idx]?.innerText?.trim() || null;
          }
          if (txt.includes('yrs. at company')) {
            yearsAtCompany = descValues[idx]?.innerText?.trim() || null;
          }
        });

        return {
          name,
          title,
          location,
          email,
          linkedin_profile,
          company,
          linkedin_company,
          avatar,
          yearsInRole,
          yearsAtCompany,
        };
      });
    }
  );

  return items.filter((item) => item.name || item.company);
}

/* -------------------------------------------------------
   SEARCH + SCRAPE FOR ONE NAME
------------------------------------------------------- */
async function searchAndScrapeForName(page, name, csvWriter, aggregated) {
  await searchBroker(page, name);

  // Wait a bit for results to load
  await sleep(1500);

  // Check if ANY card exists
  const cards = await page.$$(selectors.card);
  if (cards.length === 0) {
    console.log(`❌ No results found for: ${name}`);
    return aggregated;
  }

  console.log(`Found ${cards.length} result(s) for: ${name}`);

  // Scrape only what's currently on screen (no scrolling)
  const results = await scrapePage(page);

  if (results.length > 0) {
    console.log(`📦 Saved ${results.length} item(s) for: ${name}`);
    aggregated.push(...results);
    await csvWriter.writeRecords(results);
  } else {
    console.log(`⚠️ Something went wrong: no data scraped for: ${name}`);
  }

  return aggregated;
}

/* -------------------------------------------------------
   MAIN
------------------------------------------------------- */
async function main() {
  await fs.ensureDir('output');

  const browser = await puppeteerExtra.launch({
    headless: false,
    args: ['--no-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  await page.goto(START_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // await waitForLogin(page, selectors.card);

  await autoLogin(page);

  await sleep(3000);

  console.log('Opening Broker Contacts tab...');
  await clickByText(page, selectors.brokerTabText);
  await page.waitForSelector(selectors.card);
  await sleep(2000);

  // CSV writer
  const csvWriter = createObjectCsvWriter({
    path: OUTPUT_CSV,
    header: [
      { id: 'name', title: 'Name' },
      { id: 'title', title: 'Title' },
      { id: 'location', title: 'Location' },
      { id: 'email', title: 'Email' },
      { id: 'company', title: 'Company' },
      { id: 'linkedin_profile', title: 'LinkedIn Profile' },
      { id: 'linkedin_company', title: 'Company LinkedIn' },
      { id: 'avatar', title: 'Avatar URL' },
      { id: 'yearsInRole', title: 'Years in Role' },
      { id: 'yearsAtCompany', title: 'Years at Company' },
    ],
    append: fs.existsSync(OUTPUT_CSV),
  });

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
