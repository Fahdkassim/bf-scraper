import fs from 'fs-extra';
import path from 'path';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createObjectCsvWriter } from 'csv-writer';
import selectors from './selectors.config.js';

puppeteerExtra.use(StealthPlugin());

const START_URL = 'https://benefit-flow.com/Search';
const OUTPUT_JSON = path.join('output', 'data.json');
const OUTPUT_CSV = path.join('output', 'data.csv');

async function clickByText(page, text) {
  await page.evaluate((t) => {
    const elements = Array.from(
      document.querySelectorAll('p, div, span, button')
    );
    const el = elements.find((e) => e.innerText.trim() === t.trim());
    if (el) el.click();
  }, text);
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

/* -------------------------------------------------------
   SCRAPE A PAGE OF CARDS
------------------------------------------------------- */
async function scrapePage(page) {
  const items = await page.$$eval(
    'div[data-testid="card-container"]',
    (cards) => {
      return cards.map((card) => {
        // LEFT COLUMN - Broker info
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

        // RIGHT COLUMN - Company info
        const companyCol = card.children[1];
        const company =
          companyCol
            .querySelector('[data-testid="card-title"]')
            ?.innerText?.trim() || null;
        const linkedin_company =
          companyCol.querySelector('a[href*="linkedin.com/company"]')?.href ||
          null;

        // Email
        const email =
          card
            .querySelector('[data-testid="visible-email"]')
            ?.innerText?.trim() || null;

        // Years in role / years at company
        const descriptionValues = card.querySelectorAll(
          '[data-testid="description-value"]'
        );
        const descriptionLabels = card.querySelectorAll(
          '[data-testid="description-label"]'
        );

        let yearsInRole = null;
        let yearsAtCompany = null;

        descriptionLabels.forEach((label, index) => {
          const text = label.innerText?.trim().toLowerCase();
          if (text.includes('yrs. in role')) {
            yearsInRole = descriptionValues[index]?.innerText?.trim() || null;
          }
          if (text.includes('yrs. at company')) {
            yearsAtCompany =
              descriptionValues[index]?.innerText?.trim() || null;
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
   INFINITE SCROLL SCRAPER
------------------------------------------------------- */
async function scrapeInfiniteScroll(page, waitAfterScroll = 10000) {
  console.log('Preparing for controlled scrolling...');
  await page.mouse.move(640, 400);

  const scrapeStart = Date.now();

  let allData = [];

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

  let i = 1;
  while (true) {
    console.log(`Scroll #${i} ...`);
    i++;

    await page.mouse.wheel({ deltaY: 800 });
    await sleep(waitAfterScroll);

    const newData = await scrapePage(page);
    const uniqueNewData = newData.filter(
      (v) =>
        !allData.some(
          (t) =>
            (t.email && t.email === v.email) ||
            (t.linkedin_profile && t.linkedin_profile === v.linkedin_profile)
        )
    );

    if (!uniqueNewData.length) {
      console.log('No new cards found. Scrolling completed.');
      break;
    }

    allData.push(...uniqueNewData);
    console.log(`Aggregated card count: ${allData.length}`);

    await fs.writeJson(OUTPUT_JSON, allData, { spaces: 2 });
    await csvWriter.writeRecords(uniqueNewData);
  }

  const scrapeEnd = Date.now();
  const scrapeMinutes = ((scrapeEnd - scrapeStart) / 1000 / 60).toFixed(2);
  console.log(`⏳ Total scraping time: ${scrapeMinutes} minutes`);

  return allData;
}

/* -------------------------------------------------------
   MAIN SCRIPT
------------------------------------------------------- */
async function main() {
  await fs.ensureDir('output');

  const browser = await puppeteerExtra.launch({
    headless: false,
    args: ['--no-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Step 1: Navigate to search page
  await page.goto(START_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // Step 2: Manual login
  await waitForLogin(page, selectors.card);
  await sleep(5000);

  // Step 3: Click Broker Contacts tab
  console.log('Clicking Broker Contacts tab...');
  await clickByText(page, selectors.brokerTabText);
  await page.waitForSelector(selectors.card, { timeout: 30000 });
  await sleep(5000);

  // Step 4: Scroll + scrape
  console.log('Scrolling and scraping incrementally...');
  await scrapeInfiniteScroll(page, 10000);

  console.log('Scraping complete. Data saved to JSON & CSV.');

  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
