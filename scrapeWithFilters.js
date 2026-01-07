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

// Input filters here

const companyNameFilter = 'alera';
const roleFilter = ['producer'];
const jobTitleFilter = 'consultant';
const locationFilters = [];
// Additional filters
const creditUsageFilter = 'unused'; // options "used" , "unused" , "all"
const yearsAtCompanyFilterMin = 2;
const yearsAtCompanyFilterMax = 5;

async function clickByText(page, text) {
  await page.evaluate((t) => {
    const elements = Array.from(
      document.querySelectorAll('p, div, span, button')
    );
    const el = elements.find((e) => e.innerText.trim() === t.trim());
    if (el) el.click();
  }, text);
}

// async function waitForLogin(page, checkSelector, timeout = 300_000) {
//   console.log('Please log in manually...');
//   try {
//     await page.waitForSelector(checkSelector, { timeout });
//     console.log('Login detected! Search page loaded.');
//   } catch (err) {
//     throw new Error('Timeout waiting for login/search page.');
//   }
// }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/* -------------------------------------------------------
   🔥 APPLY OFFICE LOCATION FILTER
------------------------------------------------------- */
async function applyOfficeLocationFilter(page, location) {
  console.log(`Applying Location Filter: ${location}`);

  // Expand the Location collapsible
  await page.evaluate(() => {
    const sections = Array.from(document.querySelectorAll('.ds_collapsible'));
    const locSection = sections.find((sec) =>
      sec.innerText.includes('Location')
    );
    if (locSection && locSection.classList.contains('closed')) {
      locSection.querySelector('.ds_collapsible-button')?.click();
    }
  });

  // Use manual delay instead of page.waitForTimeout
  await sleep(1000);

  const inputSelector = 'input[data-testid="hq-location-filter-input"]';

  await page.waitForSelector(inputSelector, { timeout: 10000 });

  // Clear input
  await page.focus(inputSelector);
  await page.click(inputSelector, { clickCount: 3 });
  await page.keyboard.press('Backspace');

  // Type location
  await page.type(inputSelector, location, { delay: 50 });

  // Wait for autocomplete dropdown to appear with options
  await page.waitForFunction(
    () => {
      const dropdown = document.querySelector(
        '[data-testid^="auto-complete-component-options"]:not(.hidden)'
      );
      if (!dropdown) return false;
      const options = dropdown.querySelectorAll(
        '[data-testid^="auto-complete-option-"]'
      );
      return options.length > 0;
    },
    { timeout: 8000 }
  );

  // Additional wait to ensure options are fully rendered
  await sleep(5000);

  // Press Enter to select the first option
  await page.keyboard.press('Enter');

  // Wait for cards to refresh
  await page.waitForFunction(
    () =>
      document.querySelectorAll('div[data-testid="card-container"]').length > 0,
    { timeout: 15000 }
  );

  console.log(`✔ Location filter applied successfully: ${location}`);
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

  await sleep(1000);

  // ✅ Wait for autocomplete dropdown to appear
  const dropdownSelector =
    '[data-testid^="auto-complete-component-options"]:not(.hidden)';
  await page.waitForSelector(dropdownSelector, { timeout: 5000 });

  await sleep(1000);
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

/* -------------------------------------------------------
   🔥 APPLY ROLE FILTER
------------------------------------------------------- */
async function applyRoleFilter(page, roleName) {
  console.log(`Applying Role Filter: ${roleName}`);

  // Expand the Role collapsible
  await page.evaluate(() => {
    const sections = Array.from(document.querySelectorAll('.ds_collapsible'));
    const roleSection = sections.find((sec) => sec.innerText.includes('Role'));
    if (roleSection && roleSection.classList.contains('closed')) {
      roleSection.querySelector('.ds_collapsible-button')?.click();
    }
  });

  await new Promise((res) => setTimeout(res, 700));

  const inputSelector =
    '.ds_collapsible input.ds_input[placeholder="e.g. Producer"]';
  await page.waitForSelector(inputSelector, { timeout: 10000 });

  await page.focus(inputSelector);
  await page.click(inputSelector, { clickCount: 3 });
  await page.keyboard.press('Backspace');

  // Type role name
  await page.type(inputSelector, roleName, { delay: 50 });

  // ✅ Wait for autocomplete dropdown to appear
  const dropdownSelector =
    '[data-testid^="auto-complete-component-options"]:not(.hidden)';
  await page.waitForSelector(dropdownSelector, { timeout: 5000 });

  // Press Enter AFTER dropdown appears
  await sleep(1000);
  await page.keyboard.press('Enter');

  // Wait for cards to appear
  await page.waitForFunction(
    () =>
      document.querySelectorAll('div[data-testid="card-container"]').length > 0,
    { timeout: 15000 }
  );

  console.log(`✔ Role filter applied successfully: ${roleName}`);
}

/* -------------------------------------------------------
   🔥 APPLY JOB TITLE FILTER
------------------------------------------------------- */
async function applyJobTitleFilter(page, jobTitle) {
  console.log(`Applying Job Title Filter: ${jobTitle}`);

  // Expand the Job Title collapsible
  await page.evaluate(() => {
    const sections = Array.from(document.querySelectorAll('.ds_collapsible'));
    const jobTitleSection = sections.find((sec) =>
      sec.innerText.includes('Job Title')
    );
    if (jobTitleSection && jobTitleSection.classList.contains('closed')) {
      jobTitleSection.querySelector('.ds_collapsible-button')?.click();
    }
  });

  // Use manual delay instead of page.waitForTimeout
  await new Promise((res) => setTimeout(res, 600));

  const inputSelector =
    '.ds_collapsible input.ds_input[placeholder="e.g Consultant"]';

  await page.waitForSelector(inputSelector, { timeout: 10000 });

  // Clear input
  await page.focus(inputSelector);
  await page.click(inputSelector, { clickCount: 3 });
  await page.keyboard.press('Backspace');

  // Type job title
  await page.type(inputSelector, jobTitle, { delay: 50 });

  // Wait for autocomplete dropdown
  const dropdownSelector =
    '[data-testid^="auto-complete-component-options"]:not(.hidden)';

  await page.waitForSelector(dropdownSelector, { timeout: 5000 });

  // Press Enter to select
  await sleep(1000);
  await page.keyboard.press('Enter');

  // Wait for cards to refresh
  await page.waitForFunction(
    () =>
      document.querySelectorAll('div[data-testid="card-container"]').length > 0,
    { timeout: 15000 }
  );

  console.log(`✔ Job Title filter applied successfully: ${jobTitle}`);
}

/* -------------------------------------------------------
   🔥 APPLY CREDIT USAGE FILTER
------------------------------------------------------- */

/**
 * Apply Credit Usage filter
 * @param {import('puppeteer').Page} page
 * @param {'all'|'used'|'unused'} option
 */
async function applyCreditUsageFilter(page, option = 'all') {
  console.log(`Applying Credit Usage Filter: ${option}`);

  // Expand collapsible if closed
  await page.evaluate(() => {
    const sections = Array.from(document.querySelectorAll('.ds_collapsible'));
    const creditSection = sections.find((sec) =>
      sec.innerText.includes('Credit Usage')
    );
    if (creditSection && creditSection.classList.contains('closed')) {
      creditSection.querySelector('.ds_collapsible-button')?.click();
    }
  });

  // Wait for animation / rendering
  await new Promise((res) => setTimeout(res, 700));

  // Map friendly name to radio value
  const valueMap = {
    all: '',
    used: 'purchased',
    unused: 'not_purchased',
  };

  const selectedValue = valueMap[option];

  if (selectedValue === undefined) {
    throw new Error(`Invalid credit usage option: ${option}`);
  }

  // Click the appropriate radio
  await page.evaluate((val) => {
    const radios = Array.from(
      document.querySelectorAll('input[type="radio"][name^="radio-filter-"]')
    );
    const target = radios.find((r) => r.value === val);
    if (target) {
      target.click();
    }
  }, selectedValue);

  // Give page time to apply filter and refresh cards
  await new Promise((res) => setTimeout(res, 1000));

  await page.waitForFunction(
    () =>
      document.querySelectorAll('div[data-testid="card-container"]').length > 0,
    { timeout: 15000 }
  );

  console.log(`✔ Credit Usage filter applied: ${option}`);
}

/**
 * Apply Years At Company filter
 * @param {import('puppeteer').Page} page
 * @param {number} minYears - Minimum years at company (0 = No Min)
 * @param {number} maxYears - Maximum years at company (21 = No Max)
 */
async function applyYearsAtCompanyFilter(page, minYears = 0, maxYears = 21) {
  console.log(`Applying Years At Company Filter: ${minYears} → ${maxYears}`);

  // Expand collapsible if closed
  await page.evaluate(() => {
    const sections = Array.from(document.querySelectorAll('.ds_collapsible'));
    const yearsSection = sections.find((sec) =>
      sec.innerText.includes('Years At Company')
    );
    if (yearsSection && yearsSection.classList.contains('closed')) {
      yearsSection.querySelector('.ds_collapsible-button')?.click();
    }
  });

  await new Promise((res) => setTimeout(res, 700));

  // Get all selects inside this section
  const selects = await page.$$(
    'div.ds_collapsible-open-content select[data-testid="years-at-company-filter-start-input"]'
  );

  if (!selects.length || selects.length < 2) {
    throw new Error('Could not find both min and max year selects');
  }

  // Select min years
  await selects[0].select(String(minYears));

  // Select max years
  await selects[1].select(String(maxYears));

  // Wait for cards to refresh
  await page.waitForFunction(
    () =>
      document.querySelectorAll('div[data-testid="card-container"]').length > 0,
    { timeout: 15000 }
  );

  console.log(`✔ Years At Company filter applied successfully.`);
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

    await page.mouse.wheel({ deltaY: 1000 });
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
  await page.setViewport({ width: 1280, height: 1000 });

  // Step 1: Navigate to search page
  await page.goto(START_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // Step 2: login
  // await waitForLogin(page, selectors.card);
  await autoLogin(page);
  await sleep(5000);

  // Step 3: Click Broker Contacts tab
  console.log('Clicking Broker Contacts tab...');
  await clickByText(page, selectors.brokerTabText);
  await page.waitForSelector(selectors.card, { timeout: 30000 });
  await sleep(5000);

  // 🔥 Step 4: Apply Filters
  await sleep(1000);
  await applyCompanyNameFilter(page, companyNameFilter);
  await sleep(1000);
  for (const loc of locationFilters) {
    console.log(`\n===== Applying location: ${loc} =====`);
    await applyOfficeLocationFilter(page, loc);
    await sleep(1000);
  }
  await sleep(1000);
  for (const role of roleFilter) {
    await applyRoleFilter(page, role);
    await sleep(1000);
  }
  await sleep(1000);
  await applyJobTitleFilter(page, jobTitleFilter);
  await sleep(1000);
  // await applyCreditUsageFilter(page, creditUsageFilter);
  // await sleep(1000);
  // await applyYearsAtCompanyFilter(
  //   page,
  //   yearsAtCompanyFilterMin,
  //   yearsAtCompanyFilterMax
  // );
  // await sleep(1000);
  // Step 5: Scroll + scrape
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
