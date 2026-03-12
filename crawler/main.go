// Crawler is a minimal Go service that crawls a root URL (same domain),
// discovers up to 50 page URLs (depth 0–1 plus at most one depth-2 per first segment), and inserts them into the existing `page` table.
// Usage: crawler --org-id=<uuid> <rootURL>
// Requires DATABASE_URL in the environment.
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gocolly/colly/v2"
	_ "github.com/jackc/pgx/v5/stdlib"
)

const maxURLs = 50

// pathDepth returns the number of path segments after normalizing the URL path.
// Root "/" or empty path = 0, "/about" = 1, "/blog/post" = 2.
func pathDepth(rawURL string) int {
	u, err := url.Parse(rawURL)
	if err != nil {
		return -1
	}
	path := u.Path
	path = strings.Trim(path, "/")
	if path == "" {
		return 0
	}
	segments := strings.Split(path, "/")
	return len(segments)
}

// firstPathSegment returns the first path segment for a normalized URL (e.g. "/blog/why-it" -> "blog"). Empty if depth < 2.
func firstPathSegment(normalizedURL string) string {
	u, err := url.Parse(normalizedURL)
	if err != nil {
		return ""
	}
	path := strings.Trim(u.Path, "/")
	if path == "" {
		return ""
	}
	segments := strings.Split(path, "/")
	if len(segments) < 2 {
		return ""
	}
	return segments[0]
}

// normalizeURL returns a full absolute URL with no query, fragment, and normalized path.
func normalizeURL(base *url.URL, raw string) (string, error) {
	parsed, err := base.Parse(raw)
	if err != nil {
		return "", err
	}
	return normalizeURLFromParsed(parsed), nil
}

// normalizeURLFromParsed returns a canonical URL string (no query/fragment, path trimmed).
func normalizeURLFromParsed(u *url.URL) string {
	u = &url.URL{Scheme: u.Scheme, Host: u.Host, Path: u.Path}
	u.RawQuery = ""
	u.Fragment = ""
	path := strings.TrimSuffix(u.Path, "/")
	if path == "" {
		path = "/"
	}
	u.Path = path
	return u.String()
}

// isIndexable returns false if the response signals noindex (meta tag or X-Robots-Tag header).
func isIndexable(r *colly.Response) bool {
	// X-Robots-Tag header (e.g. noindex, none, noindex, nofollow)
	if v := r.Headers.Get("X-Robots-Tag"); v != "" {
		if strings.Contains(strings.ToLower(v), "noindex") {
			return false
		}
	}
	// Meta name="robots" or name="googlebot" with content containing noindex
	body := r.Body
	if len(body) == 0 {
		return true
	}
	bodyStr := strings.ToLower(string(body))
	// Match <meta ... name="robots" ... content="..."> or name="googlebot"; content may come before or after name
	metaRx := regexp.MustCompile(`<meta\s[^>]*>`)
	for _, match := range metaRx.FindAllString(bodyStr, -1) {
		if (strings.Contains(match, `name="robots"`) || strings.Contains(match, `name="googlebot"`)) &&
			strings.Contains(match, "noindex") {
			return false
		}
	}
	return true
}

// skipExtension returns true if the URL path suggests a non-HTML resource.
func skipExtension(u *url.URL) bool {
	path := strings.ToLower(u.Path)
	exts := []string{".jpg", ".jpeg", ".png", ".gif", ".webp", ".ico", ".svg",
		".css", ".js", ".mjs", ".pdf", ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".webm", ".mp3"}
	for _, ext := range exts {
		if strings.HasSuffix(path, ext) {
			return true
		}
	}
	return false
}

func run(ctx context.Context, rootURL string, orgID string, db *sql.DB) error {
	root, err := url.Parse(rootURL)
	if err != nil {
		return fmt.Errorf("parse root URL: %w", err)
	}
	if root.Scheme == "" || root.Host == "" {
		return fmt.Errorf("root URL must be absolute (e.g. https://example.com)")
	}

	// Same-domain only, async, parallelism 200-300, no JS, no batching. Respect robots.txt.
	c := colly.NewCollector(colly.Async(true))
	c.AllowedDomains = []string{root.Host}
	c.Limit(&colly.LimitRule{DomainGlob: "*", Parallelism: 250})
	c.IgnoreRobotsTxt = false

	var insertedCount atomic.Int32
	// depth2Segments tracks which first path segments already have one depth-2 URL stored (e.g. "blog" -> one of /blog/*).
	var depth2SegmentsMu sync.Mutex
	depth2Segments := make(map[string]bool)

	insertStmt, err := db.PrepareContext(ctx, `INSERT INTO page (organization_id, url)
SELECT $1::uuid, $2
WHERE NOT EXISTS (SELECT 1 FROM page WHERE organization_id = $1 AND url = $2)`)
	if err != nil {
		return fmt.Errorf("prepare insert: %w", err)
	}
	defer insertStmt.Close()

	// Try to insert a URL; returns true if a row was inserted. Only counts toward limit when insert succeeds.
	tryInsert := func(normalizedURL string) (inserted bool) {
		if insertedCount.Load() >= maxURLs {
			return false
		}
		res, err := insertStmt.ExecContext(ctx, orgID, normalizedURL)
		if err != nil {
			log.Printf("insert error for %q: %v", normalizedURL, err)
			return false
		}
		n, _ := res.RowsAffected()
		if n == 1 {
			insertedCount.Add(1)
			return true
		}
		return false
	}

	// Skip non-HTML by extension so Colly never requests them.
	c.OnRequest(func(r *colly.Request) {
		u := r.URL
		if skipExtension(u) {
			r.Abort()
			return
		}
	})

	c.OnResponse(func(r *colly.Response) {
		// Insert only if indexable (no noindex meta or X-Robots-Tag), then by depth rules.
		if !isIndexable(r) {
			return
		}
		normalized := normalizeURLFromParsed(r.Request.URL)
		depth := pathDepth(normalized)
		if depth <= 1 {
			tryInsert(normalized)
			return
		}
		// Depth 2: store at most one URL per first path segment (e.g. one under /blog, one under /products).
		if depth == 2 {
			segment := firstPathSegment(normalized)
			if segment == "" {
				return
			}
			depth2SegmentsMu.Lock()
			if depth2Segments[segment] {
				depth2SegmentsMu.Unlock()
				return
			}
			inserted := tryInsert(normalized)
			if inserted {
				depth2Segments[segment] = true
			}
			depth2SegmentsMu.Unlock()
		}
	})

	c.OnHTML("a[href]", func(e *colly.HTMLElement) {
		if insertedCount.Load() >= maxURLs {
			return
		}
		href := e.Request.AbsoluteURL(e.Attr("href"))
		if href == "" {
			return
		}
		normalized, err := normalizeURL(e.Request.URL, href)
		if err != nil {
			return
		}
		if pathDepth(normalized) > 2 {
			return
		}
		// Only queue visit; insert happens in OnResponse after we fetch and confirm indexable.
		if insertedCount.Load() < maxURLs {
			_ = e.Request.Visit(href)
		}
	})

	c.OnError(func(r *colly.Response, err error) {
		log.Printf("request error %s: %v", r.Request.URL, err)
	})

	// Ensure root has a trailing slash for Colly visit, then visit.
	visitURL := root.String()
	if !strings.HasSuffix(visitURL, "/") && root.Path == "" {
		visitURL += "/"
	}
	if err := c.Visit(visitURL); err != nil {
		return fmt.Errorf("visit root: %w", err)
	}
	c.Wait()
	return nil
}

func main() {
	orgID := flag.String("org-id", "", "Organization UUID")
	flag.Parse()
	rootURL := strings.TrimSpace(flag.Arg(0))

	if *orgID == "" || rootURL == "" {
		log.Fatal("Usage: crawler --org-id=<uuid> <rootURL>")
	}

	connStr := os.Getenv("DATABASE_URL")
	if connStr == "" {
		log.Fatal("DATABASE_URL is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	db, err := sql.Open("pgx", connStr)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(2)

	if err := db.PingContext(ctx); err != nil {
		log.Fatalf("ping db: %v", err)
	}

	if err := run(ctx, rootURL, *orgID, db); err != nil {
		log.Fatalf("crawl: %v", err)
	}
	log.Printf("Crawl finished for %s", rootURL)
}
