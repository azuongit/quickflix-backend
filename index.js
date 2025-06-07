import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
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
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });
  }
  return browser;
};

// Scrape catalog from filmax.to
app.get('/api/catalog', async (req, res) => {
  try {
    const { page = 1, search = '', type = 'all' } = req.query;
    const cacheKey = `catalog_${page}_${search}_${type}`;
    
    // Check cache first
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const browser = await initBrowser();
    const browserPage = await browser.newPage();
    
    // Set user agent to avoid detection
    await browserPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    let url = 'https://filmax.to';
    if (search) {
      url += `/search?q=${encodeURIComponent(search)}`;
    } else if (type === 'movies') {
      url += '/movies';
    } else if (type === 'series') {
      url += '/series';
    }
    
    if (page > 1) {
      url += `${search ? '&' : '?'}page=${page}`;
    }

    await browserPage.goto(url, { waitUntil: 'networkidle2' });
    
    // Wait for content to load
    await browserPage.waitForSelector('.movie-item, .series-item, .content-item', { timeout: 10000 });
    
    const content = await browserPage.content();
    const $ = cheerio.load(content);
    
    const items = [];
    
    // Scrape movie/series items (adjust selectors based on actual site structure)
    $('.movie-item, .series-item, .content-item').each((index, element) => {
      const $el = $(element);
      const title = $el.find('.title, h3, .movie-title').text().trim();
      const poster = $el.find('img').attr('src') || $el.find('img').attr('data-src');
      const link = $el.find('a').attr('href');
      const year = $el.find('.year, .release-year').text().trim();
      const rating = $el.find('.rating, .imdb-rating').text().trim();
      const type = $el.hasClass('series-item') ? 'series' : 'movie';
      
      if (title && link) {
        items.push({
          id: `${type}_${index}_${Date.now()}`,
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
    
    await browserPage.close();
    
    const result = {
      items,
      totalPages: parseInt($('.pagination .page-numbers').last().text()) || 1,
      currentPage: parseInt(page),
      totalItems: items.length
    };
    
    // Cache the result
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
    if (!link) {
      return res.status(400).json({ error: 'Content link required' });
    }
    
    const cacheKey = `content_${Buffer.from(link).toString('base64')}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const browser = await initBrowser();
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    await page.goto(link, { waitUntil: 'networkidle2' });
    
    // Extract detailed information
    const content = await page.content();
    const $ = cheerio.load(content);
    
    const title = $('.movie-title, .series-title, h1').first().text().trim();
    const synopsis = $('.synopsis, .description, .plot').first().text().trim();
    const poster = $('.poster img, .movie-poster img').attr('src');
    const year = $('.year, .release-year').text().trim();
    const duration = $('.duration, .runtime').text().trim();
    const genres = $('.genre').map((i, el) => $(el).text().trim()).get();
    const rating = $('.rating, .imdb-rating').text().trim();
    
    // Extract video players/iframes
    const videoLinks = [];
    
    // Look for iframes with video sources
    $('iframe').each((index, element) => {
      const src = $(element).attr('src');
      if (src && (src.includes('streamtape') || src.includes('vidplay') || src.includes('doodstream') || src.includes('mixdrop'))) {
        videoLinks.push({
          id: `link_${index}`,
          provider: extractProviderName(src),
          quality: 'HD',
          format: 'MP4',
          size: 'Unknown',
          url: src,
          type: 'iframe'
        });
      }
    });
    
    // Look for direct video links in scripts
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
    
    if (!iframeUrl) {
      return res.status(400).json({ error: 'iframe URL required' });
    }
    
    const browser = await initBrowser();
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    // Intercept network requests to catch video URLs
    const videoUrls = [];
    
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('.mp4') || url.includes('.m3u8') || url.includes('.mkv')) {
        videoUrls.push(url);
      }
    });
    
    await page.goto(iframeUrl, { waitUntil: 'networkidle2' });
    
    // Wait a bit for any dynamic content to load
    await page.waitForTimeout(3000);
    
    // Try to find download buttons or direct links
    const content = await page.content();
    const $ = cheerio.load(content);
    
    const downloadLinks = [];
    
    // Look for download buttons
    $('a[href*=".mp4"], a[href*=".mkv"], a[download]').each((index, element) => {
      const href = $(element).attr('href');
      if (href) {
        downloadLinks.push(href);
      }
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

// Helper function to extract provider name from URL
function extractProviderName(url) {
  if (url.includes('streamtape')) return 'StreamTape';
  if (url.includes('vidplay')) return 'VidPlay';
  if (url.includes('doodstream')) return 'DoodStream';
  if (url.includes('mixdrop')) return 'MixDrop';
  if (url.includes('upstream')) return 'UpStream';
  return 'Unknown Provider';
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`QuickFlix server running on port ${PORT}`);
});
