#!/usr/bin/env node
/**
 * Daily Shipping Report Automation
 * Runs via GitHub Actions (Mon-Sat 5am PST) or manually.
 *
 * 1. Launches Puppeteer, loads index.html, waits for NWS data
 * 2. Extracts report via page.evaluate(() => generateReport())
 * 3. Converts HTML to Slack mrkdwn
 * 4. Captures clean screenshot
 * 5. Posts to Slack via Block Kit (section + image + button)
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const SLACK_CHANNEL = 'C0AJPKT1FTJ';
const HEATMAP_URL = 'https://jtenbosch.github.io/shipping-heatmap/';
const SCREENSHOT_URL = 'https://jtenbosch.github.io/shipping-heatmap/screenshots/latest.png';
const MEMPHIS_FIPS = '47157';

// ── Helpers ──────────────────────────────────────────────────────

function htmlToMrkdwn(html) {
  return html
    // Strip the status label span (we add it separately in the message header)
    .replace(/<p><span class="report-status[^"]*">[^<]*<\/span><\/p>/g, '')
    .replace(/<strong>(.*?)<\/strong>/g, '*$1*')
    .replace(/<\/p>\s*<p>/g, '\n\n')
    .replace(/<\/?p>/g, '')
    .replace(/<span[^>]*>(.*?)<\/span>/g, '$1')
    .trim();
}

function formatDate() {
  return new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Los_Angeles'
  });
}

async function postToSlack(token, blocks, fallbackText) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL,
      text: fallbackText,
      blocks
    })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data;
}

async function loadPageWithRetry(page, url, maxAttempts = 3) {
  const delays = [10000, 30000, 60000];
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      // Wait for NWS data to load and map to render
      await new Promise(r => setTimeout(r, 5000));
      // Verify data loaded by checking for countyScores
      const hasData = await page.evaluate(() =>
        typeof countyScores !== 'undefined' && Object.keys(countyScores).length > 0
      );
      if (hasData) return true;
      // Data might legitimately be empty (no alerts), check if fetch completed
      const fetchDone = await page.evaluate(() =>
        typeof countyScores !== 'undefined'
      );
      if (fetchDone) return true;
      throw new Error('Data not loaded');
    } catch (err) {
      console.error(`Attempt ${i + 1}/${maxAttempts} failed: ${err.message}`);
      if (i < maxAttempts - 1) {
        console.log(`Retrying in ${delays[i] / 1000}s...`);
        await new Promise(r => setTimeout(r, delays[i]));
      } else {
        throw new Error(`Failed after ${maxAttempts} attempts: ${err.message}`);
      }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────

(async () => {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('SLACK_BOT_TOKEN environment variable is required');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });

    const htmlFile = path.join(__dirname, 'index.html');
    const fileUrl = `file://${path.resolve(htmlFile)}`;
    console.log('Loading heatmap...');
    await loadPageWithRetry(page, fileUrl);
    console.log('Data loaded successfully');

    // Extract report from the page (no logic duplication)
    const report = await page.evaluate(() => generateReport());
    const reportText = htmlToMrkdwn(report.html);
    console.log(`Report level: ${report.level}`);

    // Check if Memphis superhub is affected
    const memphisAffected = await page.evaluate((fips) => {
      return countyScores[fips] && countyScores[fips].score > 0;
    }, MEMPHIS_FIPS);

    const memphisAlert = await page.evaluate((fips) => {
      const data = countyScores[fips];
      if (!data || data.score === 0) return null;
      const topAlert = data.alerts.sort((a, b) => b.score - a.score)[0];
      return topAlert ? topAlert.event : 'weather alerts';
    }, MEMPHIS_FIPS);

    // Capture screenshot (hide UI controls)
    await page.addStyleTag({
      content: `
        #report-btn, #refresh-btn, .leaflet-control-zoom,
        .leaflet-control-attribution, .info, .header span { display: none !important; }
      `
    });
    await new Promise(r => setTimeout(r, 500));

    const screenshotDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);
    const screenshotPath = path.join(screenshotDir, 'latest.png');
    await page.screenshot({ path: screenshotPath, type: 'png' });
    console.log(`Screenshot saved: ${screenshotPath}`);

    // Build Slack message
    const date = formatDate();
    const emoji = { high: ':red_circle:', moderate: ':large_orange_circle:', low: ':large_green_circle:' }[report.level];
    const riskLabel = { high: 'HIGH DISRUPTION', moderate: 'MODERATE DISRUPTION', low: 'LOW RISK' }[report.level];
    const cacheBust = Date.now();

    let messageBody = `${emoji} *Shipping Report — ${date}*\n*${riskLabel}*\n\n${reportText}`;

    // Add Memphis superhub callout for moderate/high
    if (memphisAffected && report.level !== 'low') {
      messageBody += `\n\n:warning: *FedEx Memphis Superhub (Shelby County, TN)* under ${memphisAlert} — expect significant delays on packages routing through Memphis.`;
    }

    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: messageBody }
      },
      {
        type: 'image',
        image_url: `${SCREENSHOT_URL}?t=${cacheBust}`,
        alt_text: `Shipping heatmap for ${date}`
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: ':bar_chart: *Explore the full county-level breakdown:*' },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Open Interactive Heatmap', emoji: true },
          url: HEATMAP_URL,
          style: 'primary'
        }
      }
    ];

    const fallbackText = `Shipping Report — ${date}`;
    console.log('Posting to Slack...');
    await postToSlack(token, blocks, fallbackText);
    console.log('Slack message posted successfully');

  } finally {
    await browser.close();
  }
})();
