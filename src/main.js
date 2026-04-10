/**
 * Skool Web Research Actor  v3.0
 * ================================
 * Scrapes review platforms + search engines za Skool podatke.
 * Sources: Trustpilot, G2, Capterra, Bing search → article scraping.
 * Nema Skool.com scraping (zahteva login) — koristimo javne izvore.
 *
 * Flow:
 *  1. Trustpilot reviews (multi-page)
 *  2. G2 reviews
 *  3. Bing + DuckDuckGo search (20+ queries) → extract article URLs
 *  4. Scrape pronađene článke za sadržaj koji pominje Skool
 */

import { Actor, log } from 'apify';
import { CheerioCrawler, PuppeteerCrawler, sleep } from 'crawlee';

await Actor.init();

const input = await Actor.getInput() ?? {};

const {
  trustpilotPages   = 10,
  g2Pages           = 5,
  searchQueries     = [
    'skool community platform review',
    'skool.com review 2024',
    'skool vs kajabi comparison',
    'skool vs circle.so comparison',
    'skool vs mighty networks comparison',
    'skool alternative platforms',
    'skool community problems',
    'skool platform worth it',
    'skool membership site pros cons',
    'skool pricing honest review',
    'skool community engagement tips',
    'skool platform limitations',
    'online community platform review 2024',
    'best platform for online course community',
    'skool sam ovens platform review',
    'skool alex hormozi recommendation',
    'skool community owner experience',
    'skool vs thinkific community',
    'skool gamification leaderboard review',
    'membership site platform comparison 2024',
  ],
  maxArticlesPerQuery = 5,
  proxyConfig = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
} = input;

const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig);
const seenUrls = new Set();

// ─── CHEERIO CRAWLER (fast HTML — Trustpilot, Bing, articles) ─────────────────

const cheerioCrawler = new CheerioCrawler({
  proxyConfiguration,
  maxConcurrency: 5,
  requestHandlerTimeoutSecs: 30,
  maxRequestRetries: 3,

  async requestHandler({ request, $ }) {
    const { type, query, page: pageNum = 1 } = request.userData;

    // ── TRUSTPILOT ─────────────────────────────────────────────────────────────
    if (type === 'trustpilot') {
      log.info(`Trustpilot page ${pageNum}`);

      const reviews = [];
      $('article[data-service-review-card-paper], .styles_reviewCard__9HxJJ, [class*="reviewCard"]').each((_, el) => {
        const rating  = $(el).find('[data-service-review-rating], [class*="star_rating"]').attr('data-service-review-rating')
                     ?? $(el).find('img[alt*="star"]').attr('alt')?.match(/\d/)?.[0]
                     ?? '?';
        const title   = $(el).find('h2, [class*="reviewTitle"], [data-service-review-title-typography]').text().trim();
        const body    = $(el).find('p[class*="reviewContent"], [data-service-review-text], .styles_reviewContent__0Q2Tg').text().trim();
        const author  = $(el).find('[class*="consumerName"], [data-consumer-name-typography]').text().trim();
        const dateEl  = $(el).find('time');
        const date    = dateEl.attr('datetime') ?? dateEl.text().trim();

        if (body.length > 30) {
          reviews.push({ rating, title, body, author, date });
        }
      });

      log.info(`  ${reviews.length} reviews na stranici ${pageNum}`);

      for (const r of reviews) {
        await Actor.pushData({
          source:      'Trustpilot',
          url:         request.url,
          rating:      r.rating,
          title:       r.title,
          body:        r.body,
          author:      r.author,
          date:        r.date,
          scraped_at:  new Date().toISOString(),
        });
      }

      // Sledeća stranica
      if (reviews.length > 0 && pageNum < trustpilotPages) {
        await Actor.addRequests([{
          url: `https://www.trustpilot.com/review/skool.com?page=${pageNum + 1}`,
          userData: { type: 'trustpilot', page: pageNum + 1 },
        }]);
      }
    }

    // ── BING SEARCH ────────────────────────────────────────────────────────────
    else if (type === 'bing_search') {
      log.info(`Bing: "${query}"`);

      const articleUrls = [];
      $('.b_algo h2 a, .b_algo .b_title a').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || !href.startsWith('http')) return;
        // Skip: Reddit (handled separately), social media, video sites
        if (/reddit\.com|twitter\.com|facebook\.com|instagram\.com|youtube\.com|tiktok\.com/i.test(href)) return;
        // Skip: own sites and spam
        if (/trustpilot\.com|g2\.com|capterra\.com/i.test(href)) return; // already scraped
        if (!seenUrls.has(href)) {
          articleUrls.push(href);
          seenUrls.add(href);
        }
      });

      log.info(`  ${articleUrls.length} article URLs pronađeno`);
      for (const url of articleUrls.slice(0, maxArticlesPerQuery)) {
        await Actor.addRequests([{ url, userData: { type: 'article', searchQuery: query } }]);
      }
    }

    // ── DUCKDUCKGO SEARCH ──────────────────────────────────────────────────────
    else if (type === 'ddg_search') {
      log.info(`DDG: "${query}"`);

      const articleUrls = [];
      $('.result__a, .result__url, a.result__a').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || !href.startsWith('http')) return;
        if (/reddit\.com|twitter\.com|facebook\.com|youtube\.com/i.test(href)) return;
        if (!seenUrls.has(href)) {
          articleUrls.push(href);
          seenUrls.add(href);
        }
      });

      for (const url of articleUrls.slice(0, maxArticlesPerQuery)) {
        await Actor.addRequests([{ url, userData: { type: 'article', searchQuery: query } }]);
      }
    }

    // ── ARTICLE SCRAPING ──────────────────────────────────────────────────────
    else if (type === 'article') {
      const { searchQuery } = request.userData;

      // Probaj razne content selektore (blog, news, review sites)
      const contentSelectors = [
        'article .entry-content',
        'article .post-content',
        'article .article-body',
        '.post-content',
        '.entry-content',
        '.article-content',
        'article',
        'main article',
        'main .content',
        '[itemprop="articleBody"]',
      ];

      let content = '';
      for (const sel of contentSelectors) {
        const text = $(sel).text().trim();
        if (text.length > 200) { content = text; break; }
      }

      if (!content) content = $('main, body').text().trim().slice(0, 5000);

      // Filtriraj — uzmi samo ako pominje Skool
      const skoolMentions = (content.match(/skool/gi) ?? []).length;
      if (skoolMentions < 2) {
        log.debug(`  Skip (${skoolMentions} Skool mentions): ${request.url}`);
        return;
      }

      const title = $('h1').first().text().trim() || $('title').text().trim();
      const metaDesc = $('meta[name="description"]').attr('content') ?? '';

      log.info(`  Article: "${title?.slice(0, 60)}" | Skool mentions: ${skoolMentions}`);

      await Actor.pushData({
        source:          'Web Article',
        url:             request.url,
        search_query:    searchQuery,
        title,
        meta_description: metaDesc,
        content:         content.replace(/\s+/g, ' ').slice(0, 5000),
        skool_mentions:  skoolMentions,
        scraped_at:      new Date().toISOString(),
      });
    }
  },

  failedRequestHandler({ request, error }) {
    log.warning(`FAILED [cheerio]: ${request.url} — ${error.message}`);
  },
});

// ─── PUPPETEER CRAWLER (JS-heavy — G2, Capterra) ─────────────────────────────

const puppeteerCrawler = new PuppeteerCrawler({
  proxyConfiguration,
  maxConcurrency: 1,
  requestHandlerTimeoutSecs: 60,
  maxRequestRetries: 2,

  launchContext: {
    launchOptions: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  },

  async requestHandler({ page, request }) {
    const { type, pageNum = 1 } = request.userData;

    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    // ── G2 REVIEWS ──────────────────────────────────────────────────────────────
    if (type === 'g2') {
      log.info(`G2 page ${pageNum}`);

      try {
        await page.waitForSelector('[itemprop="reviewBody"], .formatted-text', { timeout: 20000 });
      } catch {
        log.warning(`G2 content not loaded: ${request.url}`);
        return;
      }
      await sleep(1500);

      const reviews = await page.evaluate(() => {
        const cards = document.querySelectorAll('[itemprop="review"], .review-card, [class*="paper_paper"]');
        const results = [];
        cards.forEach(card => {
          const ratingEl = card.querySelector('[itemprop="ratingValue"], .stars-icon');
          const titleEl  = card.querySelector('[itemprop="name"], h3');
          const bodyEl   = card.querySelector('[itemprop="reviewBody"], .formatted-text, [class*="reviewBody"]');
          const dateEl   = card.querySelector('time, [itemprop="datePublished"]');
          const body     = bodyEl?.innerText?.trim() ?? '';
          if (body.length < 30) return;
          results.push({
            rating: ratingEl?.getAttribute('content') ?? ratingEl?.innerText?.trim() ?? '?',
            title:  titleEl?.innerText?.trim() ?? '',
            body,
            date:   dateEl?.getAttribute('datetime') ?? dateEl?.innerText?.trim() ?? '',
          });
        });
        return results;
      });

      log.info(`  ${reviews.length} G2 reviews`);
      for (const r of reviews) {
        await Actor.pushData({
          source:     'G2',
          url:        request.url,
          rating:     r.rating,
          title:      r.title,
          body:       r.body,
          date:       r.date,
          scraped_at: new Date().toISOString(),
        });
      }

      // Next page
      if (reviews.length > 0 && pageNum < g2Pages) {
        await Actor.addRequests([{
          url: `https://www.g2.com/products/skool/reviews?page=${pageNum + 1}`,
          userData: { type: 'g2', pageNum: pageNum + 1 },
        }]);
      }
    }

    // ── CAPTERRA ──────────────────────────────────────────────────────────────
    else if (type === 'capterra') {
      log.info(`Capterra: ${request.url}`);

      try {
        await page.waitForSelector('[class*="review-content"], .review-text, [data-testid*="review"]', { timeout: 20000 });
      } catch {
        log.warning(`Capterra content not loaded`);
        return;
      }
      await sleep(1000);

      const reviews = await page.evaluate(() => {
        const cards = document.querySelectorAll('[class*="ReviewCard"], [data-testid*="review-card"]');
        const results = [];
        cards.forEach(card => {
          const bodyEl = card.querySelector('[class*="review-content"], [class*="reviewBody"], p');
          const body   = bodyEl?.innerText?.trim() ?? '';
          if (body.length < 30) return;
          const ratingEl = card.querySelector('[class*="rating"], [aria-label*="star"]');
          results.push({
            body,
            rating: ratingEl?.getAttribute('aria-label') ?? ratingEl?.innerText?.trim() ?? '?',
          });
        });
        return results;
      });

      for (const r of reviews) {
        await Actor.pushData({
          source:     'Capterra',
          url:        request.url,
          body:       r.body,
          rating:     r.rating,
          scraped_at: new Date().toISOString(),
        });
      }
    }
  },

  failedRequestHandler({ request, error }) {
    log.warning(`FAILED [puppeteer]: ${request.url} — ${error.message}`);
  },
});

// ─── Run Cheerio (Trustpilot + Search + Articles) ────────────────────────────

const cheerioRequests = [
  // Trustpilot — start page 1, auto-paginate
  { url: 'https://www.trustpilot.com/review/skool.com?page=1', userData: { type: 'trustpilot', page: 1 } },

  // Bing search — sve queries
  ...searchQueries.map(q => ({
    url: `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=30&setlang=en`,
    userData: { type: 'bing_search', query: q },
  })),

  // DuckDuckGo — prvih 10 queries (fallback)
  ...searchQueries.slice(0, 10).map(q => ({
    url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    userData: { type: 'ddg_search', query: q },
  })),
];

log.info(`Starting cheerio crawler: ${cheerioRequests.length} requests`);
await cheerioCrawler.run(cheerioRequests);

// ─── Run Puppeteer (G2 + Capterra) ───────────────────────────────────────────

const puppeteerRequests = [
  { url: 'https://www.g2.com/products/skool/reviews', userData: { type: 'g2', pageNum: 1 } },
  { url: 'https://www.capterra.com/p/search-results/?keyword=skool', userData: { type: 'capterra' } },
];

log.info(`Starting puppeteer crawler: ${puppeteerRequests.length} requests`);
await puppeteerCrawler.run(puppeteerRequests);

log.info('\nDone. Results in Apify Dataset.');
await Actor.exit();
