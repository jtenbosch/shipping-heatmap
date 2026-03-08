#!/usr/bin/env node
/**
 * Daily Shipping Report Automation
 * Runs via GitHub Actions (Mon-Sat 5am PST) or manually.
 *
 * Two modes (run via CLI flag):
 *   --screenshot  Generate screenshot + save report data to report.json
 *   --post        Read report.json and post to Slack
 *
 * This split allows the workflow to push the screenshot to GitHub Pages
 * before posting to Slack, so the embedded image URL is always current.
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const SLACK_CHANNEL = 'C0AJPKT1FTJ';
const HEATMAP_URL = 'https://jtenbosch.github.io/shipping-heatmap/';
const SCREENSHOT_BASE_URL = 'https://jtenbosch.github.io/shipping-heatmap/screenshots';
const MEMPHIS_FIPS = '47157';
const REPORT_JSON = path.join(__dirname, 'report.json');

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

function todayStamp() {
  const now = new Date();
  const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const y = pst.getFullYear();
  const m = String(pst.getMonth() + 1).padStart(2, '0');
  const d = String(pst.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
  if (!data.ok) throw new Error(`Slack API error: ${data.error}${data.response_metadata ? ' — ' + JSON.stringify(data.response_metadata) : ''}`);
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

// ── Screenshot mode ──────────────────────────────────────────────

async function runScreenshot() {
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
    const dateStamp = todayStamp();
    const latestPath = path.join(screenshotDir, 'latest.png');
    const datedPath = path.join(screenshotDir, `${dateStamp}.png`);
    await page.screenshot({ path: latestPath, type: 'png' });
    fs.copyFileSync(latestPath, datedPath);
    console.log(`Screenshots saved: latest.png + ${dateStamp}.png`);

    // Update OG image tag in index.html to use dated screenshot URL
    const indexPath = path.join(__dirname, 'index.html');
    let indexHtml = fs.readFileSync(indexPath, 'utf8');
    indexHtml = indexHtml.replace(
      /(<meta property="og:image" content=")[^"]*(")/,
      `$1${SCREENSHOT_BASE_URL}/${dateStamp}.png$2`
    );
    fs.writeFileSync(indexPath, indexHtml);
    console.log(`Updated OG image tag to ${dateStamp}.png`);

    // Save report data for the post step
    const reportData = {
      level: report.level,
      reportText,
      memphisAffected,
      memphisAlert,
      date: formatDate(),
      dateStamp
    };
    fs.writeFileSync(REPORT_JSON, JSON.stringify(reportData, null, 2));
    console.log(`Report data saved: ${REPORT_JSON}`);

  } finally {
    await browser.close();
  }
}

// ── Post mode ────────────────────────────────────────────────────

async function runPost() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('SLACK_BOT_TOKEN environment variable is required');
    process.exit(1);
  }

  if (!fs.existsSync(REPORT_JSON)) {
    console.error(`Report data not found: ${REPORT_JSON}. Run with --screenshot first.`);
    process.exit(1);
  }

  const reportData = JSON.parse(fs.readFileSync(REPORT_JSON, 'utf8'));
  const { level, reportText, memphisAffected, memphisAlert, date, dateStamp } = reportData;

  const emoji = { high: ':red_circle:', moderate: ':large_orange_circle:', low: ':large_green_circle:' }[level];
  const riskLabel = { high: 'HIGH DISRUPTION', moderate: 'MODERATE DISRUPTION', low: 'LOW RISK' }[level];
  const screenshotUrl = `${SCREENSHOT_BASE_URL}/${dateStamp}.png`;

  let messageBody = `${emoji} *Shipping Report — ${date}*\n*${riskLabel}*\n\n${reportText}`;

  // Add Memphis superhub callout for moderate/high
  if (memphisAffected && level !== 'low') {
    messageBody += `\n\n:warning: *FedEx Memphis Superhub (Shelby County, TN)* under ${memphisAlert} — expect significant delays on packages routing through Memphis.`;
  }

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: messageBody }
    },
    {
      type: 'image',
      title: { type: 'plain_text', text: `Shipping Heatmap — ${date}` },
      image_url: screenshotUrl,
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
}

// ── CLI ──────────────────────────────────────────────────────────

const mode = process.argv[2];
if (mode === '--screenshot') {
  runScreenshot().catch(err => { console.error(err); process.exit(1); });
} else if (mode === '--post') {
  runPost().catch(err => { console.error(err); process.exit(1); });
} else {
  console.error('Usage: daily-report.js --screenshot | --post');
  process.exit(1);
}
