import express from "express";
import path from "path";
import crypto from "crypto";
import * as cheerio from "cheerio";
import { createServer as createViteServer } from "vite";

const app = express();
const PORT = 3000;

// Enable JSON parsing
app.use(express.json());

// Ephemeral cache storage
interface CacheEntry {
  id: string;
  type: 'search' | 'url';
  queryOrUrl: string;
  data: any;
  createdAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

// Cumulative statistics and recent logs trackers
const uniqueVisitors = new Set<string>();
let totalSearches = 0;
let totalProxies = 0;
let totalReadings = 0;
let totalSessionsCreated = 0;
const recentQueries: string[] = [];
const recentDomains: string[] = [];
let adminPin: string | null = null;

function addRecentQuery(q: string) {
  if (!q || typeof q !== "string") return;
  const cleaned = q.trim();
  if (!cleaned) return;
  recentQueries.push(cleaned);
  if (recentQueries.length > 20) {
    recentQueries.shift();
  }
}

function addRecentDomain(urlStr: string) {
  if (!urlStr || typeof urlStr !== "string") return;
  try {
    let absoluteUrl = urlStr.trim();
    if (!/^https?:\/\//i.test(absoluteUrl)) {
      absoluteUrl = "https://" + absoluteUrl;
    }
    const parsed = new URL(absoluteUrl);
    const domain = parsed.hostname;
    if (domain) {
      recentDomains.push(domain);
      if (recentDomains.length > 20) {
        recentDomains.shift();
      }
    }
  } catch (e) {
    // ignore
  }
}

// Active cache cleanup worker (runs every 30 seconds)
setInterval(() => {
  const now = Date.now();
  let evictedCount = 0;
  for (const [id, entry] of cache.entries()) {
    if (now - entry.createdAt > CACHE_TTL) {
      cache.delete(id);
      evictedCount++;
    }
  }
  if (evictedCount > 0) {
    console.log(`[Cache Worker] Evicted ${evictedCount} expired entries.`);
  }
}, 30000);

// Helper to generate a session-scoped random ID
function generateId(): string {
  return "relay_" + crypto.randomBytes(16).toString("hex");
}

// Scrape DuckDuckGo HTML search page
async function scrapeDuckDuckGo(query: string): Promise<any[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://html.duckduckgo.com/',
        'Cache-Control': 'no-cache'
      }
    });

    if (!response.ok) {
      throw new Error(`Search engine returned status ${response.status}`);
    }

    const htmlText = await response.text();
    const $ = cheerio.load(htmlText);
    const results: any[] = [];

    $('.result').each((i, element) => {
      const titleEl = $(element).find('.result__title a');
      const title = titleEl.text().trim();
      let link = titleEl.attr('href') || '';
      const snippet = $(element).find('.result__snippet').text().trim();
      
      if (title && link) {
        // Clean up relative links and DDG redirect paths
        if (link.startsWith('//')) {
          link = 'https:' + link;
        } else if (link.startsWith('/')) {
          link = 'https://html.duckduckgo.com' + link;
        }
        
        if (link.includes('/l/?uddg=')) {
          try {
            const urlObj = new URL(link);
            const uddg = urlObj.searchParams.get('uddg');
            if (uddg) {
              link = decodeURIComponent(uddg);
            }
          } catch (e) {
            // keep standard link
          }
        }
        results.push({ title, link, snippet });
      }
    });

    return results.slice(0, 10);
  } catch (error) {
    console.error(`Scraping error:`, error);
    throw error;
  }
}

// Scrape any URL and parse a clean Reader Mode layout
async function scrapeUrlContent(targetUrl: string): Promise<{ title: string; content: string[]; sourceUrl: string }> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch (e) {
    throw new Error("Invalid URL format. Please include http:// or https://");
  }

  const response = await fetch(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    }
  });

  if (!response.ok) {
    throw new Error(`Webpage fetch failed with status ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("xhtml") && !contentType.includes("text/plain")) {
    throw new Error(`Unsupported content format: ${contentType}. Reader mode supports text/html pages.`);
  }

  const htmlText = await response.text();
  const $ = cheerio.load(htmlText);

  // Extract the title
  const title = $('title').text().trim() || $('h1').first().text().trim() || parsedUrl.hostname;

  // Strip scripts, stylesheets, interactive components, widgets
  $('script, style, iframe, noscript, svg, form, header, footer, nav, video, audio, link').remove();
  $('.sidebar, #sidebar, .comments, #comments, .menu, #menu, .footer, #footer, .nav, #nav, .ad, .ads, .advertisement, .share, .social').remove();

  const contentParagraphs: string[] = [];
  
  // Extract paragraphs, subheadings, lists
  $('h1, h2, h3, h4, p, li').each((i, el) => {
    const tagName = el.name;
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (text && text.length > 12) {
      if (tagName.startsWith('h')) {
        contentParagraphs.push(`### ${text}`);
      } else {
        contentParagraphs.push(text);
      }
    }
  });

  if (contentParagraphs.length === 0) {
    // Broad fallback body text collection
    const bodyText = $('body').text().trim().split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 50);
    contentParagraphs.push(...bodyText);
  }

  return {
    title,
    content: contentParagraphs.slice(0, 60), // Cap at 60 entries for performance
    sourceUrl: targetUrl
  };
}

// Fallback search suggestions when DDG is rate-limited
function generateSimulatedResults(query: string): any[] {
  const cleanQuery = query.trim();
  return [
    {
      title: `${cleanQuery} - Comprehensive Research & Insights`,
      link: `https://en.wikipedia.org/wiki/${encodeURIComponent(cleanQuery)}`,
      snippet: `Explore structured knowledge and historical articles about "${cleanQuery}". This is a client-side relay recommendation based on privacy indexing.`,
    },
    {
      title: `Latest News and Updates about ${cleanQuery}`,
      link: `https://news.google.com/search?q=${encodeURIComponent(cleanQuery)}`,
      snippet: `Relayed link to view live headlines and community discussions regarding ${cleanQuery}. Open via our URL reader for maximum privacy protection.`,
    },
    {
      title: `Open Source Discussions: ${cleanQuery}`,
      link: `https://github.com/search?q=${encodeURIComponent(cleanQuery)}`,
      snippet: `Discover active code repositories, developer contributions, and technical documentation matching "${cleanQuery}".`,
    },
    {
      title: `Reddit Conversations: ${cleanQuery}`,
      link: `https://www.reddit.com/search/?q=${encodeURIComponent(cleanQuery)}`,
      snippet: `Public perspectives, discussions, and real-time questions asked by the global community on r/all regarding "${cleanQuery}".`,
    }
  ];
}

// API: Health / Status
app.get("/api/health", (req, res) => {
  const ip = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '127.0.0.1').split(',')[0].trim();
  uniqueVisitors.add(ip);

  res.json({
    status: "ok",
    activeCacheCount: cache.size,
    ttlMinutes: 5,
    pinSet: adminPin !== null
  });
});

// API: Admin status
app.get("/api/admin/status", (req, res) => {
  res.json({ pinSet: adminPin !== null });
});

// API: Setup Admin PIN
app.post("/api/admin/setup", (req, res) => {
  const { pin } = req.body;
  if (!pin || typeof pin !== "string" || pin.trim().length < 4) {
    return res.status(400).json({ error: "PIN must be at least 4 characters/digits long." });
  }

  if (adminPin !== null) {
    return res.status(400).json({ error: "Admin PIN is already set. Use verify/change options." });
  }

  adminPin = pin.trim();
  res.json({ success: true, message: "Admin PIN configured successfully." });
});

// API: Verify PIN and fetch stats
app.post("/api/admin/verify", (req, res) => {
  const { pin } = req.body;
  if (!pin || typeof pin !== "string") {
    return res.status(400).json({ success: false, error: "PIN is required." });
  }

  if (adminPin === null) {
    return res.status(400).json({ success: false, error: "Admin PIN is not set yet. Please set it first." });
  }

  if (adminPin !== pin.trim()) {
    return res.status(401).json({ success: false, error: "Incorrect Admin PIN. Access Denied." });
  }

  res.json({
    success: true,
    stats: {
      uniqueVisitorsCount: uniqueVisitors.size,
      totalSearches,
      totalProxies,
      totalReadings,
      totalSessionsCreated,
      recentQueries: [...recentQueries].reverse(),
      recentDomains: [...recentDomains].reverse(),
    }
  });
});

// API: Change Admin PIN
app.post("/api/admin/change-pin", (req, res) => {
  const { currentPin, newPin } = req.body;
  
  if (adminPin === null) {
    return res.status(400).json({ error: "Admin PIN is not set yet." });
  }

  if (adminPin !== (currentPin || "").trim()) {
    return res.status(401).json({ error: "Incorrect current PIN." });
  }

  if (!newPin || typeof newPin !== "string" || newPin.trim().length < 4) {
    return res.status(400).json({ error: "New PIN must be at least 4 characters/digits long." });
  }

  adminPin = newPin.trim();
  res.json({ success: true, message: "Admin PIN updated successfully." });
});

// API: Perform Search (Relay)
app.post("/api/search", async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== "string" || query.trim() === "") {
    return res.status(400).json({ error: "Query is required" });
  }

  try {
    totalSearches++;
    totalSessionsCreated++;
    addRecentQuery(query);

    let results: any[];
    let isSimulated = false;

    try {
      results = await scrapeDuckDuckGo(query);
      if (results.length === 0) {
        results = generateSimulatedResults(query);
        isSimulated = true;
      }
    } catch (scrapingErr) {
      console.warn("Real-time scraper failed or was blocked, falling back to simulated results.");
      results = generateSimulatedResults(query);
      isSimulated = true;
    }

    const id = generateId();
    const now = Date.now();
    
    // Store in cache
    cache.set(id, {
      id,
      type: 'search',
      queryOrUrl: query,
      data: { results, isSimulated },
      createdAt: now
    });

    res.json({
      success: true,
      resultId: id,
      expiresAt: now + CACHE_TTL
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "An unexpected error occurred during the relay operation." });
  }
});

// API: Perform URL Scrape (Relay)
app.post("/api/scrape", async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== "string" || url.trim() === "") {
    return res.status(400).json({ error: "A valid URL is required" });
  }

  try {
    totalReadings++;
    totalSessionsCreated++;
    addRecentDomain(url);

    const data = await scrapeUrlContent(url.trim());
    const id = generateId();
    const now = Date.now();

    cache.set(id, {
      id,
      type: 'url',
      queryOrUrl: url,
      data,
      createdAt: now
    });

    res.json({
      success: true,
      resultId: id,
      expiresAt: now + CACHE_TTL
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to parse target webpage. Ensure it is a public URL and allows fetch requests." });
  }
});

// API: Fetch cached results by ID
app.get("/api/results/:id", (req, res) => {
  const { id } = req.params;
  const entry = cache.get(id);

  if (!entry) {
    return res.status(404).json({ error: "The requested search session has expired or does not exist. Remember, all sessions are completely erased from memory after 5 minutes." });
  }

  const timeLeft = Math.max(0, CACHE_TTL - (Date.now() - entry.createdAt));

  res.json({
    type: entry.type,
    queryOrUrl: entry.queryOrUrl,
    data: entry.data,
    expiresAt: entry.createdAt + CACHE_TTL,
    secondsRemaining: Math.floor(timeLeft / 1000)
  });
});

// API: Full Browser Proxy / Relay
app.get("/api/proxy", async (req, res) => {
  const targetUrl = (req.query.url as string || "").trim();
  if (!targetUrl) {
    return res.status(400).send("<h3>URL query parameter is required</h3>");
  }

  try {
    totalProxies++;
    let absoluteUrl = targetUrl;
    if (!/^https?:\/\//i.test(absoluteUrl)) {
      absoluteUrl = "https://" + absoluteUrl;
    }
    addRecentDomain(absoluteUrl);

    // Quick parse validation and normalization
    const parsedUrl = new URL(absoluteUrl);

    // Fetch target website using fully normalized URL-encoded href string
    const response = await fetch(parsedUrl.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });

    if (!response.ok) {
      return res.status(response.status).send(`
        <div style="font-family: sans-serif; padding: 30px; text-align: center; color: #e11d48; background: #fff5f5; border: 1px solid #fee2e2; border-radius: 12px; max-width: 500px; margin: 40px auto; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05);">
          <h3 style="margin-top: 0;">Failed to load webpage</h3>
          <p>The target server responded with code <strong>${response.status} (${response.statusText})</strong>.</p>
          <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">Some servers actively block headless cloud IPs or refuse to serve unauthenticated requests. Try another standard website or double check the address.</p>
        </div>
      `);
    }

    const contentType = response.headers.get("content-type") || "";
    
    // If it's not HTML, redirect to the real URL or serve directly
    if (!contentType.includes("text/html") && !contentType.includes("xhtml")) {
      return res.redirect(absoluteUrl);
    }

    let html = await response.text();
    const $ = cheerio.load(html);

    // Remove headers/metas that interfere
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="content-security-policy"]').remove();

    // Setup base URL reference
    $('head').prepend(`<base href="${absoluteUrl}">`);

    // Rewrite all links inside the webpage to route through our proxy
    $('a').each((_, el) => {
      const href = $(el).attr('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        try {
          const resolved = new URL(href, absoluteUrl).href;
          $(el).attr('href', `/api/proxy?url=${encodeURIComponent(resolved)}`);
          $(el).attr('target', '_self'); // guarantee navigation inside iframe
        } catch (e) {
          // keep original
        }
      }
    });

    // Rewrite form actions
    $('form').each((_, el) => {
      const action = $(el).attr('action');
      if (action) {
        try {
          const resolved = new URL(action, absoluteUrl).href;
          $(el).attr('action', `/api/proxy?url=${encodeURIComponent(resolved)}`);
        } catch (e) {}
      }
    });

    // Rewrite stylesheets, scripts and images to use absolute paths
    // so they load correctly inside the proxy context
    $('link').each((_, el) => {
      const href = $(el).attr('href');
      if (href) {
        try {
          $(el).attr('href', new URL(href, absoluteUrl).href);
        } catch (e) {}
      }
    });

    $('script').each((_, el) => {
      const src = $(el).attr('src');
      if (src) {
        try {
          $(el).attr('src', new URL(src, absoluteUrl).href);
        } catch (e) {}
      }
    });

    $('img').each((_, el) => {
      const src = $(el).attr('src');
      if (src) {
        try {
          $(el).attr('src', new URL(src, absoluteUrl).href);
        } catch (e) {}
      }
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send($.html());
  } catch (error: any) {
    res.status(500).send(`
      <div style="font-family: sans-serif; padding: 30px; text-align: center; color: #b91c1c; background: #fef2f2; border: 1px solid #fee2e2; border-radius: 12px; max-width: 500px; margin: 40px auto; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05);">
        <h3 style="margin-top: 0;">Proxy Connection Refused</h3>
        <p>${error.message}</p>
        <p style="font-size: 13px; color: #4b5563; line-height: 1.5;">Please double check the address format. Make sure the website starts with http:// or https:// and is publicly accessible.</p>
      </div>
    `);
  }
});

// Setup Vite & Frontend static routing
async function initServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Relay Engine] Running on http://0.0.0.0:${PORT} in ${process.env.NODE_ENV || "development"} mode.`);
  });
}

initServer().catch(console.error);
