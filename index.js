require('dotenv').config();
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { runScanForOrganization } = require('./lib/scan');

const PORT = process.env.PORT || 8080;
const MAX_BODY_SIZE = 4 * 1024; // 4KB
const REQUEST_TIMEOUT_MS = 10 * 1000; // 10s
const MAX_URL_LENGTH = 2048;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getCrawlerBinPath() {
  return process.env.CRAWLER_BIN_PATH || path.join(__dirname, 'bin', 'crawler');
}

function log(level, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

function send(res, statusCode, body = null, contentType = 'application/json') {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', contentType);
  if (body) {
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  } else {
    res.end();
  }
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function validateAuth(req) {
  const secret = process.env.CRAWLER_SERVICE_SECRET;
  if (!secret) {
    log('error', 'CRAWLER_SERVICE_SECRET not configured');
    return false;
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  return timingSafeEqual(token, secret);
}

function validateBody(body) {
  if (!body || typeof body !== 'object') {
    return { error: 'Invalid or missing JSON body' };
  }
  const { organizationId, websiteUrl } = body;
  if (!organizationId || typeof organizationId !== 'string') {
    return { error: 'Invalid organizationId' };
  }
  if (!UUID_V4_REGEX.test(organizationId.trim())) {
    return { error: 'Invalid organizationId' };
  }
  if (!websiteUrl || typeof websiteUrl !== 'string') {
    return { error: 'Invalid websiteUrl' };
  }
  const url = websiteUrl.trim();
  if (url.length > MAX_URL_LENGTH) {
    return { error: 'websiteUrl too long' };
  }
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { error: 'Invalid websiteUrl' };
    }
  } catch {
    return { error: 'Invalid websiteUrl' };
  }
  return null;
}

function spawnCrawler(organizationId, websiteUrl) {
  const binPath = getCrawlerBinPath();
  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL || '',
  };
  const child = spawn(binPath, ['--org-id=' + organizationId, websiteUrl], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
  child.unref();
  child.on('error', (err) => {
    log('error', 'Crawler spawn error', { organizationId, error: err.message });
  });
  child.on('exit', (code, signal) => {
    if (code === 0) {
      runScanForOrganization(organizationId).catch((err) => {
        log('error', 'Post-crawl scan failed', { organizationId, error: err.message });
      });
    } else {
      const crawlerStdout = Buffer.concat(stdoutChunks).toString('utf8').trim() || null;
      const crawlerStderr = Buffer.concat(stderrChunks).toString('utf8').trim() || null;
      log('error', 'Crawler exited with non-zero status', {
        organizationId,
        code,
        signal,
        crawlerStdout: crawlerStdout || undefined,
        crawlerStderr: crawlerStderr || undefined,
      });
    }
  });
  return child;
}

function handleCrawl(req, res, body) {
  if (!validateAuth(req)) {
    log('info', 'Crawl request rejected', { status: 401 });
    send(res, 401, { error: 'Unauthorized' });
    return;
  }

  const validationError = validateBody(body);
  if (validationError) {
    log('info', 'Crawl request rejected', { status: 400, error: validationError.error });
    send(res, 400, validationError);
    return;
  }

  const organizationId = body.organizationId.trim();
  const websiteUrl = body.websiteUrl.trim();

  try {
    spawnCrawler(organizationId, websiteUrl);
    log('info', 'Crawl started', { status: 202, organizationId });
    send(res, 202, { ok: true });
  } catch (err) {
    log('error', 'Crawler spawn failed', { organizationId, error: err.message });
    send(res, 500, { error: 'Failed to start crawler' });
  }
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let overflow = false;
    req.on('data', (chunk) => {
      if (body.length + chunk.length > MAX_BODY_SIZE) {
        overflow = true;
      } else {
        body += chunk.toString('utf8');
      }
    });
    req.on('end', () => {
      if (overflow) {
        reject(new Error('Body too large'));
        return;
      }
      if (!body.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function handlePostCrawl(req, res) {
  parseJsonBody(req)
    .then((body) => handleCrawl(req, res, body))
    .catch((err) => {
      const message = err.message || 'Bad request';
      log('info', 'Crawl request rejected', { status: 400, error: message });
      send(res, 400, { error: message });
    });
}

function handleHealth(res) {
  send(res, 200, { status: 'ok' });
}

const server = http.createServer((req, res) => {
  req.setTimeout(REQUEST_TIMEOUT_MS, () => {
    req.destroy();
  });

  if (req.method === 'GET' && (req.url === '/health' || req.url === '/health/')) {
    handleHealth(res);
    return;
  }

  if (req.method === 'POST' && (req.url === '/crawl' || req.url === '/crawl/')) {
    handlePostCrawl(req, res);
    return;
  }

  send(res, 404, { error: 'Not Found' });
});

server.listen(Number(PORT), '0.0.0.0', () => {
  log('info', 'Crawler runner listening', { port: PORT });
});
