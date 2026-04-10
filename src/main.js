/**
 * Skool Community Monitor Actor  v2.0
 * =====================================
 * Scrapes Skool community feed stranice za pain-signal postove.
 * Sve keywords editabilne iz Input taba. NEMA AI.
 */

import { Actor, log } from 'apify';
import { PuppeteerCrawler, sleep } from 'crawlee';
import { scorePain, categorize, extractVocQuotes } from './scorer.js';

await Actor.init();

const input = await Actor.getInput() ?? {};
const {
  communitySlugs       = ['skool-community'],
  sessionCookie        = '',
  painKeywords         = ['struggling', 'broken', 'manually', 'churn', 'ghost town'],
  categoryKeywords     = { 'Onboarding & Engagement': ['onboard', 'welcome', 'ghost town'] },
  maxPostsPerCommunity = 40,
  minEngagement        = 3,
  minPainScore         = 15,
  scrapeComments       = true,
  proxyConfig          = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
} = input;

log.info('=== Skool Community Monitor v2.0 ===');
log.info(`Communities: ${communitySlugs.length} | Pain keywords: ${painKeywords.length}`);

const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig);

const crawler = new PuppeteerCrawler({
  proxyConfiguration,
  maxConcurrency:            1,
  requestHandlerTimeoutSecs: 120,
  maxRequestRetries:         2,
  launchContext: {
    launchOptions: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,900'],
    },
  },

  async requestHandler({ page, request }) {
    const { type, slug } = request.userData;

    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    // Inject session cookie za privatne community-e
    if (sessionCookie) {
      await page.setCookie({ name: 'sb', value: sessionCookie, domain: '.skool.com', path: '/', httpOnly: true, secure: true })
        .catch(() => {});
    }

    // ── FEED STRANICA ─────────────────────────────────────────────────────────
    if (type === 'feed') {
      log.info(`Loading: skool.com/c/${slug}/feed`);

      const loaded = await page.waitForSelector(
        '[class*="post"], article, [data-testid*="post"], main > div > div',
        { timeout: 35000 }
      ).catch(() => null);

      if (!loaded) {
        log.warning(`Feed nije dostupan: ${slug}`);
        return;
      }

      // Scroll da učita više postova
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => window.scrollBy(0, 900));
        await sleep(900);
      }

      const posts = await page.evaluate((maxP, minEng) => {
        // Pokušaj više selector strategija — Skool menja CSS class-ove
        const selectors = ['[class*="PostCard"]', '[class*="post-card"]', '[class*="FeedPost"]', 'article', '[data-testid*="post"]'];
        let cards = [];
        for (const sel of selectors) {
          const found = document.querySelectorAll(sel);
          if (found.length > 2) { cards = Array.from(found); break; }
        }

        const results = [];
        cards.slice(0, maxP).forEach(card => {
          const titleEl  = card.querySelector('h1, h2, h3, [class*="title" i]');
          const title    = titleEl?.textContent?.trim() ?? '';
          if (!title || title.length < 4) return;

          const linkEl   = card.querySelector('a[href*="/post/"], a[href*="/p/"]');
          const href     = linkEl?.getAttribute('href') ?? '';

          let engagement = 0;
          card.querySelectorAll('span, [class*="count" i]').forEach(el => {
            const n = parseInt(el.textContent?.trim().replace(/\D/g, '') ?? '0');
            if (n > 0 && n < 10000) engagement += n;
          });

          const bodyEl  = card.querySelector('p, [class*="body" i], [class*="content" i]');
          const preview = bodyEl?.textContent?.trim().slice(0, 300) ?? '';
          const authorEl = card.querySelector('[class*="author" i], strong');
          const author  = authorEl?.textContent?.trim() ?? 'Unknown';

          if (engagement >= minEng || title.length > 10) {
            results.push({ title, href, engagement, preview, author });
          }
        });
        return results;
      }, maxPostsPerCommunity, minEngagement);

      log.info(`  Pronađeno ${posts.length} postova u ${slug}`);

      let queued = 0;
      for (const post of posts) {
        const qs = scorePain(`${post.title} ${post.preview}`, painKeywords);
        if (qs.painScore >= minPainScore - 15 || post.engagement >= 10) {
          const url = post.href.startsWith('http') ? post.href : `https://www.skool.com${post.href}`;
          if (url.includes('/post/') || url.includes('/p/')) {
            await Actor.addRequests([{
              url,
              userData: { type: 'post', slug, postTitle: post.title, preview: post.preview, author: post.author, engagement: post.engagement },
            }]);
            queued++;
          }
        }
      }
      log.info(`  Queued ${queued} postova za full scrape`);
    }

    // ── INDIVIDUALNI POST ─────────────────────────────────────────────────────
    else if (type === 'post') {
      const { postTitle, preview, author, engagement, slug: community } = request.userData;
      await sleep(700);

      const loaded = await page.waitForSelector(
        '[class*="post-body"], [class*="PostBody"], [class*="PostContent"], main article, main p',
        { timeout: 20000 }
      ).catch(() => null);

      let bodyText = preview ?? '';

      if (loaded) {
        bodyText = await page.evaluate(() => {
          const selectors = ['[class*="PostBody"]', '[class*="post-body"]', '[class*="PostContent"]', 'article', 'main'];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.length > 30) return el.innerText?.trim() ?? '';
          }
          return '';
        });
      }

      let comments = [];
      if (scrapeComments && loaded) {
        comments = await page.evaluate(() => {
          const selectors = ['[class*="CommentBody"]', '[class*="comment-body"]', '[class*="Reply"] p'];
          for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) {
              return Array.from(els).slice(0, 8).map(el => el.innerText?.trim() ?? '').filter(t => t.length > 20);
            }
          }
          return [];
        });
      }

      const fullText = `${postTitle} ${bodyText}`;
      const scoring  = scorePain(fullText, painKeywords);
      if (scoring.painScore < minPainScore) return;

      const category     = categorize(fullText, categoryKeywords);
      const vocQuotes    = extractVocQuotes(bodyText || postTitle, painKeywords);
      const commentQuotes = comments.flatMap(c => extractVocQuotes(c, painKeywords, 2));
      const engSignal    = engagement >= 30 ? '🔥 High' : engagement >= 10 ? '🟡 Medium' : '🔵 Low';
      const finalSignal  = scoring.signal === '🔥 High' || engSignal === '🔥 High' ? '🔥 High' : scoring.signal;

      await Actor.pushData({
        source:           'Skool Community',
        community_slug:   community,
        url:              request.url,
        author,
        title:            postTitle,
        body:             bodyText.slice(0, 1800),
        engagement_score: engagement,
        problem_category: category,
        voc_quotes:       vocQuotes,
        comment_voc:      commentQuotes,
        top_comments:     comments.slice(0, 5),
        pain_score:       scoring.painScore,
        signal:           finalSignal,
        matched_words:    scoring.matchedWords,
        matched_patterns: scoring.matchedPatterns,
        scraped_at:       new Date().toISOString(),
      });

      log.info(`  ✓ [${finalSignal}] ${scoring.painScore}/100 eng=${engagement} | "${postTitle?.slice(0, 60)}"`);
    }
  },

  failedRequestHandler({ request, error }) {
    log.error(`FAILED: ${request.url} | ${error.message}`);
  },
});

const feedRequests = communitySlugs.map(slug => ({
  url: `https://www.skool.com/c/${slug}/feed`,
  userData: { type: 'feed', slug },
}));

log.info(`Queuing ${feedRequests.length} community feed-ova...`);
await crawler.run(feedRequests);

log.info('\n✅ Skool monitoring završen.');
log.info('💡 Dodaj community-e: Input → communitySlugs');
log.info('💡 Promeni pain reči: Input → painKeywords');

await Actor.exit();
