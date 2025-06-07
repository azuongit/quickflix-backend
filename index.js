import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer-core';
import chromium from 'chrome-aws-lambda';
import * as cheerio from 'cheerio';
import axios from 'axios';
import NodeCache from 'node-cache';

const app = express();
const PORT = process.env.PORT || 3001;

// Cache for 1 hour
const cache = new NodeCache({ stdTTL: 3600 });

app.use(cors());
app.use(express.json());

// Initialize browser instance
let browser = null;

const initBrowser = async () => {
  if (!browser) {
    const executablePath = await chromium.executablePath;
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless
    });
  }
  return browser;
};

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Scrape catalog from filmax.to
app.get('/api/catalog', async (req, res) => {
  try {
    const { page = 1, search = '', type = 'all' } = req.query;
    const cacheKey = `catalog_${page}_${search}_${type}`;
    
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const browser = await initBrowser();
    const pageObj = await browser.newPage();

    await pageObj.setUserAgent('Mozilla/5.0');

    let url = 'https://filmax.to';
    if (search) url += `/search?q=${encodeURIComponent(search)}`;
    else if (type === 'movies') url += '/movies';
    else if (type === 'series') url += '/series';
    if (page > 1) url += `${search ? '&' : '?'}page=${page}`;

    await pageObj.goto(url, { waitUntil: 'networkidle2' });
    await pageObj.waitForSelector('.movie-item, .series-item, .content-item', { timeout: 10000 });

    const content = await pageObj.content();
    const $ = cheerio.load(content);

    const items = [];
    $('.movie-item, .series-item, .content-item').each((i, el) => {
      const $el = $(el);
      const title = $el.find('.title, h3, .movie-title').text().trim();
      const poster = $el.find('img').attr('src') || $el.find('img').attr('data-src');
      const link = $el.find('a').attr('href');
      const year = $el.find('.year, .release-year').text().trim();
      const rating = $el.find('.rating, .imdb-rating').text().trim();
      const type = $el.hasClass('series-item') ? 'series' : 'movie';

      if (title && link) {
        items.push({
          id: `${type}_${i}_${Date.now()}`,
          title,
          type,
          year: year ? parseInt(year) : new Date().getFullYear(),
          poster: poster?.startsWith('http') ? poster : `https://filmax.to${poster}`,
          link: link.startsWith('http') ? link : `https://filmax.to${link}`,
          rating: rating ? parseFloat(rating) : null,
          synopsis: $el.find('.synopsis, .description').text().trim() || 'No description available',
          genres: $el.find('.genre').map((i, el) => $(el).text().trim()).get() || ['Unknown']
        });
      }
    });

    await pageObj.close();

    const result = {
      items,
      totalPages: parseInt($('.pagination .page-numbers').last().text()) || 1,
      currentPage: parseInt(page),
      totalItems: items.length
    };

    cache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error('Catalog scraping error:', error);
    res.status(500).json({ error: 'Failed to fetch catalog' });
  }
});

// Get detailed content info and extract video links
app.get('/api/content/:id', async (req, res) => {
  try {
    const { link } = req.query;
    if (!link) return res.status(400).json({ error: 'Content link required' });

    const cacheKey = `content_${Buffer.from(link).toString('base64')}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const browser = await initBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0');
    await page.goto(link, { waitUntil: 'networkidle2' });

    const content = await page.content();
    const $ = cheerio.load(content);

    const title = $('.movie-title, .series-title, h1').first().text().trim();
    const synopsis = $('.synopsis, .description, .plot').first().text().trim();
    const poster = $('.poster img, .movie-poster img').attr('src');
    const year = $('.year, .release-year').text().trim();
    const duration = $('.duration, .runtime').text().trim();
    const genres = $('.genre').map((i, el) => $(el).text().trim()).get();
    const rating = $('.rating, .imdb-rating').text().trim();

    const videoLinks = [];
    $('iframe').each((i, el) => {
      const src = $(el).attr('src');
      if (src && (src.includes('streamtape') || src.includes('vidplay') || src.includes('doodstream') || src.includes('mixdrop'))) {
        videoLinks.push({
          id: `link_${i}`,
          provider: extractProviderName(src),
          quality: 'HD',
          format: 'MP4',
          size: 'Unknown',
          url: src,
          type: 'iframe'
        });
      }
    });

    const scripts = $('script').map((i, el) => $(el).html()).get().join(' ');
    const videoUrlRegex = /(https?:\/\/[^\s"']+\.(?:mp4|m3u8|mkv|avi))/gi;
    const matches = scripts.match(videoUrlRegex);

    if (matches) {
      matches.forEach((url, index) => {
        videoLinks.push({
          id: `direct_${index}`,
          provider: 'Direct Link',
          quality: 'HD',
          format: url.includes('.m3u8') ? 'HLS' : 'MP4',
          size: 'Unknown',
          url: url,
          type: 'direct'
        });
      });
    }

    await page.close();

    const result = {
      title,
      synopsis: synopsis || 'No description available',
      poster: poster?.startsWith('http') ? poster : `https://filmax.to${poster}`,
      year: year ? parseInt(year) : null,
      duration,
      genres: genres.length ? genres : ['Unknown'],
      rating: rating ? parseFloat(rating) : null,
      links: videoLinks
    };

    cache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error('Content extraction error:', error);
    res.status(500).json({ error: 'Failed to extract content details' });
  }
});

// Extract actual download link from iframe
app.post('/api/extract-link', async (req, res) => {
  try {
    const { iframeUrl } = req.body;
    if (!iframeUrl) return res.status(400).json({ error: 'iframe URL required' });

    const browser = await initBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0');

    const videoUrls = [];

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('.mp4') || url.includes('.m3u8') || url.includes('.mkv')) {
        videoUrls.push(url);
      }
    });

    await page.goto(iframeUrl, { waitUntil: 'networkidle2' });
    await page.waitForTimeout(3000);

    const content = await page.content();
    const $ = cheerio.load(content);

    const downloadLinks = [];
    $('a[href*=".mp4"], a[href*=".mkv"], a[download]').each((index, element) => {
      const href = $(element).attr('href');
      if (href) downloadLinks.push(href);
    });

    await page.close();

    res.json({
      videoUrls,
      downloadLinks,
      extractedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Link extraction error:', error);
    res.status(500).json({ error: 'Failed to extract download link' });
  }
});

function extractProviderName(url) {
  if (url.includes('streamtape')) return 'StreamTape';
  if (url.includes('vidplay')) return 'VidPlay';
  if (url.includes('doodstream')) return 'DoodStream';
  if (url.includes('mixdrop')) return 'MixDrop';
  if (url.includes('upstream')) return 'UpStream';
  return 'Unknown Provider';
}

process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  if (browser) await browser.close();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`✅ QuickFlix backend running on port ${PORT}`);
});
