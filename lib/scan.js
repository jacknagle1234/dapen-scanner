'use strict';

require('dotenv').config();
const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const { Client } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const RULE_IDS = [
  'html-has-lang',
  'document-title',
  'image-alt',
  'button-name',
  'link-name',
  'label',
  'input-button-name',
  'frame-title',
  'aria-valid-attr',
  'empty-heading',
];

const CONCURRENCY = 3;
const VIEWPORT = { width: 1280, height: 720 };
const NAV_TIMEOUT_MS = 30 * 1000;

function log(level, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

function isValidS3Key(key) {
  if (typeof key !== 'string' || key.includes('..') || key.startsWith('/')) return false;
  return /^[a-zA-Z0-9_\-/.]+$/.test(key);
}

function isS3Configured() {
  return !!(
    process.env.S3_ENDPOINT &&
    process.env.S3_REGION &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY &&
    process.env.IMAGES_BUCKET_NAME
  );
}

async function uploadScreenshot(key, buffer) {
  if (!isS3Configured()) return null;
  if (!isValidS3Key(key)) {
    log('warn', 'Invalid S3 key, skipping upload', { key });
    return null;
  }
  try {
    const client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
    });
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.IMAGES_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: 'image/jpeg',
      })
    );
    return key;
  } catch (err) {
    log('error', 'S3 upload failed', { key, error: err.message });
    return null;
  }
}

function computeStatus(violations) {
  const hasCritical = violations.some((v) => v.impact === 'critical');
  const hasSeriousOrModerate = violations.some(
    (v) => v.impact === 'serious' || v.impact === 'moderate'
  );
  if (hasCritical) return 'error';
  if (hasSeriousOrModerate) return 'warning';
  return 'ok';
}

function computeCriticalErrorCount(violations) {
  return violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious' || v.impact === 'moderate'
  ).length;
}

async function scanPage(page, pageUrl) {
  await page.goto(pageUrl, {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT_MS,
  });
  const results = await new AxeBuilder({ page })
    .withRules(RULE_IDS)
    .analyze();

  const { violations } = results;
  const criticalErrorCount = computeCriticalErrorCount(violations);
  const totalViolationCount = violations.length;
  const status = computeStatus(violations);

  const scanResult = {
    violations: results.violations,
    passes: results.passes,
    incomplete: results.incomplete ?? [],
    inapplicable: results.inapplicable ?? [],
    timestamp: results.timestamp ?? new Date().toISOString(),
    url: results.url ?? pageUrl,
    testEngine: results.testEngine ?? {},
    testRunner: results.testRunner ?? {},
  };

  return {
    criticalErrorCount,
    totalViolationCount,
    status,
    scanResult,
  };
}

async function runScanForOrganization(organizationId) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for scanning');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const res = await client.query(
      'SELECT id, url FROM page WHERE organization_id = $1 AND scanned_at IS NULL',
      [organizationId]
    );
    const pages = res.rows;
    if (pages.length === 0) {
      return { scanned: 0 };
    }

    if (!isS3Configured()) {
      log('warn', 'S3 not configured; screenshots disabled', { organizationId });
    }

    const scannedAt = new Date().toISOString();
    let scanned = 0;
    const browser = await chromium.launch({ headless: true });

    try {
      const runOne = async (row) => {
        const { id: pageId, url: pageUrl } = row;
        let context;
        try {
          context = await browser.newContext({ viewport: VIEWPORT });
          const page = await context.newPage();
          const { criticalErrorCount, totalViolationCount, status, scanResult } =
            await scanPage(page, pageUrl);

          let screenshotKey = null;
          try {
            const screenshotBuffer = await page.screenshot({
              type: 'jpeg',
              quality: 50,
              fullPage: false,
            });
            const buffer = Buffer.isBuffer(screenshotBuffer)
              ? screenshotBuffer
              : Buffer.from(screenshotBuffer);
            const key = `scans/${organizationId}/${pageId}.jpg`;
            screenshotKey = await uploadScreenshot(key, buffer);
          } catch (screenErr) {
            log('warn', 'Screenshot capture failed', {
              organizationId,
              pageId,
              url: pageUrl,
              error: screenErr.message,
            });
          }

          await context.close();

          await client.query(
            `UPDATE page SET critical_error_count = $1, total_violation_count = $2, status = $3, scanned_at = $4, scan_result = $5, screenshot_key = $6, updated_at = $4 WHERE id = $7`,
            [
              criticalErrorCount,
              totalViolationCount,
              status,
              scannedAt,
              JSON.stringify(scanResult),
              screenshotKey,
              pageId,
            ]
          );
          scanned += 1;
          log('info', 'Page scanned', {
            organizationId,
            pageId,
            url: pageUrl,
            status,
          });
        } catch (err) {
          log('error', 'Scan failed for page', {
            organizationId,
            pageId,
            url: pageUrl,
            error: err.message,
          });
          if (context) await context.close().catch(() => {});
        }
      };

      for (let i = 0; i < pages.length; i += CONCURRENCY) {
        const chunk = pages.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map(runOne));
      }
    } finally {
      await browser.close();
    }

    log('info', 'Scan complete for organization', {
      organizationId,
      scanned,
      total: pages.length,
    });
    return { scanned };
  } finally {
    await client.end();
  }
}

module.exports = { runScanForOrganization };
