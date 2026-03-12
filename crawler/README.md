# Website crawler

Minimal Go service that crawls a root URL (same domain only, path depth ≤ 1), discovers up to 50 page URLs, and inserts them into the existing `page` table.

## Build

From this directory:

```bash
go build -o crawler .
```

Or from repo root: `go build -o crawler ./crawler`

## Run manually

1. Set `DATABASE_URL` (same PostgreSQL as the Next.js app).
2. Run:

```bash
./crawler --org-id=<organization-uuid> <rootURL>
```

Example:

```bash
export DATABASE_URL="postgres://user:pass@localhost:5432/dbname"
./crawler --org-id=550e8400-e29b-41d4-a716-446655440000 https://example.com
```

The crawler writes rows into the `page` table with the given `organization_id` and discovered `url` values (other columns use DB defaults).

## Trigger from the app

When an organization is created with a website URL, the Next.js app can start this crawler in the background so pages appear in the org’s Pages table.

**Enable the app trigger:** set `CRAWLER_BIN` to the **full path** of the built binary, e.g.:

- Local: `CRAWLER_BIN=/Users/you/pro-nextjs-drizzle/crawler/crawler`
- Server: `CRAWLER_BIN=/app/crawler/crawler`

If `CRAWLER_BIN` is unset or empty, the app does not run the crawler (org creation still succeeds). The crawler expects `DATABASE_URL` (same Postgres as the app) when run manually or when spawned by the app.
