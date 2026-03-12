# DAPEN Crawler Runner

HTTP service that receives crawl requests from the DAPEN main app and spawns the Go crawler binary in the background. After each crawl completes, the runner runs Playwright + axe-core on unscanned pages and updates the database. Used because Vercel cannot run long-lived processes; the main app calls this runner when a user adds a website.

## Quick start

1. **Environment:** Copy `.env.example` to `.env` and set `DATABASE_URL` and `CRAWLER_SERVICE_SECRET`.
2. **Crawler binary:** Obtain the crawler binary and place it at `bin/crawler` (or set `CRAWLER_BIN_PATH`). See [Obtaining the crawler binary](#obtaining-the-crawler-binary).
3. **Playwright:** Run `npx playwright install chromium` once so the browser is available for post-crawl scanning.
4. **Run:** `npm start` (or `node index.js`). Server listens on `PORT` (default 8080).

## Obtaining the crawler binary

The crawler lives in the main DAPEN repo under `crawler/`. **For Railway (Linux)** you must use a binary built for `linux/amd64` (or `linux/arm64` if your service uses ARM). A binary built on macOS will not run on Railway.

**Option A – Copy pre-built binary from main repo (local/dev only):**

1. In the main DAPEN repo: `cd crawler && go build -o crawler .`
2. Copy the produced `crawler` binary into this project as `bin/crawler`.
3. Make it executable: `chmod +x bin/crawler`.  
   Note: this builds for your current OS; use Option B for Railway.

**Option B – Vendor source and build for Linux (recommended for Railway):**

1. Copy the entire `crawler/` directory from the main DAPEN repo (all `.go` files, `go.mod`, `go.sum`) into this project’s root so you have `crawler/` here.
2. Build a Linux binary:
   - **Script:** `./scripts/build-crawler-linux.sh` (builds `linux/amd64`; set `CRAWLER_ARCH=arm64` for ARM).
   - **Or npm:** `npm run build:crawler` (requires Go installed).
3. Commit `bin/crawler` and deploy; Railway will use this binary. Alternatively, run the same build in your CI or Dockerfile before starting the Node server.

## API

- **POST /crawl**  
  - Headers: `Content-Type: application/json`, `Authorization: Bearer <CRAWLER_SERVICE_SECRET>`  
  - Body: `{ "organizationId": "<uuid>", "websiteUrl": "https://..." }`  
  - Success: `202 Accepted` with `{ "ok": true }`. Crawler runs in the background; when it finishes, the runner scans unscanned pages with axe-core (and captures screenshots to S3 when configured), then updates the `page` table.  
  - Errors: `401` (invalid/missing auth), `400` (invalid body/UUID/URL), `500` (spawn failure).

- **GET /health**  
  - Returns `200` with `{ "status": "ok" }` for platform health checks.

## Environment variables

| Variable                 | Required | Description                                                                 |
| ------------------------ | -------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`           | Yes      | PostgreSQL connection string (same as main app). Passed to the crawler and used for scan updates. |
| `CRAWLER_SERVICE_SECRET` | Yes      | Shared secret; must match the main app. Used for `Authorization: Bearer`.   |
| `PORT`                   | No       | HTTP port (default `8080`).                                                 |
| `CRAWLER_BIN_PATH`       | No       | Path to crawler binary (default `./bin/crawler`).                           |
| `S3_ENDPOINT`            | No       | S3/R2 endpoint URL for screenshot uploads. Same bucket as main app images. |
| `S3_REGION`              | No       | Region (e.g. `auto` for R2).                                                |
| `S3_ACCESS_KEY_ID`       | No       | S3 access key.                                                             |
| `S3_SECRET_ACCESS_KEY`   | No       | S3 secret key.                                                             |
| `IMAGES_BUCKET_NAME`     | No       | Bucket name (must match the main app’s images bucket). If any S3 var is missing, screenshots are skipped. |

## Local testing

```bash
# Start the server
node index.js

# Trigger a crawl (use a valid UUID and your secret)
curl -X POST http://localhost:8080/crawl \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SECRET" \
  -d '{"organizationId":"550e8400-e29b-41d4-a716-446655440000","websiteUrl":"https://example.com"}'
# Expect 202
```

Then check the database: table `page` should have new rows for that `organization_id`. After the crawler exits, the runner will scan each unscanned page with axe-core and set `scanned_at`, `scan_result`, `critical_error_count`, `total_violation_count`, `status`, and (when S3 is configured) `screenshot_key` after uploading a JPEG screenshot to the images bucket.

## Deployment (Railway / Render / Fly)

- Set `DATABASE_URL` and `CRAWLER_SERVICE_SECRET`.
- Expose the HTTP port (platforms usually set `PORT`).
- Ensure the crawler binary is present at runtime and built for Linux (e.g. run `./scripts/build-crawler-linux.sh` or `npm run build:crawler` and commit `bin/crawler`, or build in your Dockerfile).
- Run `npx playwright install chromium` in the deployment environment (e.g. in the Docker image or build step) so post-crawl scanning works.
- For screenshots: set `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `IMAGES_BUCKET_NAME` to match the main app’s images bucket. If unset, scans still run but `screenshot_key` is left null.
- Point the main app’s `CRAWLER_SERVICE_URL` at this service (e.g. `https://your-runner.railway.app`) and set `CRAWLER_SERVICE_SECRET` to the same value. Do not set `CRAWLER_BIN` on Vercel.
