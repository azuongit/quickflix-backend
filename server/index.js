import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import NodeCache from 'node-cache';

const app = express();
const PORT = process.env.PORT || 3001;
const cache = new NodeCache({ stdTTL: 3600 });

app.use(cors());
app.use(express.json());

const initBrowser = async () => {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });
};

app.get('/', (req, res) => {
  res.send('✅ QuickFlix backend is up and running on Render!');
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`✅ QuickFlix server running on port ${PORT}`);
});
