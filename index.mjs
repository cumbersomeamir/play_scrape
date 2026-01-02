#!/usr/bin/env node

import gplay from 'google-play-scraper';
import pLimit from 'p-limit';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default configuration
const DEFAULTS = {
  country: 'in',
  lang: 'en',
  maxApps: 5000,
  concurrency: 8,
  minRatings: 5000,
  minScore: 4.2,
  maxInstallsUpper: 500000,
  outDir: './out'
};

// Problem keywords for search
const PROBLEM_KEYWORDS = [
  'khata', 'udhaar', 'ledger', 'billing', 'invoice', 'inventory',
  'shop', 'dhanda', 'attendance', 'accounting', 'expenses',
  'cashbook', 'expense tracker', 'bookkeeping', 'pos', 'payment'
];

// Categories to search
const CATEGORIES = [
  gplay.category.BUSINESS,
  gplay.category.FINANCE,
  gplay.category.PRODUCTIVITY,
  gplay.category.TOOLS
];

// Collections to fetch
const COLLECTIONS = [
  { collection: gplay.collection.TOP_FREE, name: 'top_free' },
  { collection: gplay.collection.TOP_PAID, name: 'top_paid' },
  { collection: gplay.collection.GROSSING, name: 'top_grossing' }
];

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...DEFAULTS };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];
    
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (nextArg && !nextArg.startsWith('--')) {
        if (key === 'maxApps' || key === 'concurrency' || key === 'minRatings' || key === 'maxInstallsUpper') {
          config[key] = parseInt(nextArg, 10);
        } else if (key === 'minScore') {
          config[key] = parseFloat(nextArg);
        } else {
          config[key] = nextArg;
        }
        i++;
      }
    }
  }
  
  return config;
}

// Progress tracker
class ProgressTracker {
  constructor() {
    this.totalAppIds = 0;
    this.processed = 0;
    this.success = 0;
    this.fail = 0;
    this.filtered = 0;
    this.startTime = Date.now();
    this.lastUpdate = Date.now();
    this.lastCheckpoint = Date.now();
  }
  
  update(delta = {}) {
    this.processed += delta.processed || 0;
    this.success += delta.success || 0;
    this.fail += delta.fail || 0;
    this.filtered += delta.filtered || 0;
    
    const now = Date.now();
    if (now - this.lastUpdate >= 2000) {
      this.print();
      this.lastUpdate = now;
    }
  }
  
  print() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const rate = this.processed / elapsed;
    const remaining = this.totalAppIds - this.processed;
    const eta = remaining / rate;
    
    console.log(`[Progress] Processed: ${this.processed}/${this.totalAppIds} | ` +
      `Success: ${this.success} | Fail: ${this.fail} | Filtered: ${this.filtered} | ` +
      `Rate: ${rate.toFixed(1)}/s | ETA: ${eta.toFixed(0)}s`);
  }
  
  shouldCheckpoint() {
    const now = Date.now();
    if (this.processed % 50 === 0 || now - this.lastCheckpoint >= 30000) {
      this.lastCheckpoint = now;
      return true;
    }
    return false;
  }
  
  finalPrint() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    console.log(`\n[Complete] Total: ${this.processed} | Success: ${this.success} | ` +
      `Fail: ${this.fail} | Filtered: ${this.filtered} | Time: ${elapsed.toFixed(1)}s`);
  }
}

// Checkpoint manager
class CheckpointManager {
  constructor(checkpointPath) {
    this.checkpointPath = checkpointPath;
    this.data = {
      discoveredAppIds: new Set(),
      processedAppIds: new Set(),
      appDetails: {}
    };
    this.savePromise = null; // Mutex for saving
  }
  
  async load() {
    try {
      const content = await fs.readFile(this.checkpointPath, 'utf-8');
      const loaded = JSON.parse(content);
      
      this.data.discoveredAppIds = new Set(loaded.discoveredAppIds || []);
      this.data.processedAppIds = new Set(loaded.processedAppIds || []);
      this.data.appDetails = loaded.appDetails || {};
      
      console.log(`[Checkpoint] Loaded: ${this.data.discoveredAppIds.size} discovered, ` +
        `${this.data.processedAppIds.size} processed`);
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[Checkpoint] Load error: ${error.message}`);
      }
      return false;
    }
  }
  
  async save() {
    // If a save is already in progress, wait for it
    if (this.savePromise) {
      await this.savePromise;
      return;
    }
    
    this.savePromise = (async () => {
      try {
        const toSave = {
          discoveredAppIds: Array.from(this.data.discoveredAppIds),
          processedAppIds: Array.from(this.data.processedAppIds),
          appDetails: this.data.appDetails
        };
        await fs.writeFile(this.checkpointPath, JSON.stringify(toSave, null, 2));
      } catch (error) {
        console.warn(`[Checkpoint] Save error: ${error.message}`);
      } finally {
        this.savePromise = null;
      }
    })();
    
    await this.savePromise;
  }
  
  isProcessed(appId) {
    return this.data.processedAppIds.has(appId);
  }
  
  markProcessed(appId, details = null) {
    this.data.processedAppIds.add(appId);
    if (details) {
      this.data.appDetails[appId] = details;
    }
  }
  
  addDiscovered(appId) {
    this.data.discoveredAppIds.add(appId);
  }
  
  getDiscovered() {
    return Array.from(this.data.discoveredAppIds);
  }
}

// Fetch with timeout
async function fetchWithTimeout(fn, timeout = 30000) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), timeout)
    )
  ]);
}

// Retry wrapper
async function retry(fn, maxRetries = 2, backoff = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, backoff * (i + 1)));
    }
  }
}

// Discover apps from collections
async function discoverFromCollections(country, lang, limit = 200) {
  const appIds = new Set();
  console.log(`[Discovery] Fetching collections...`);
  
  for (const { collection, name } of COLLECTIONS) {
    try {
      console.log(`[Discovery] Fetching ${name}...`);
      const results = await fetchWithTimeout(() => 
        gplay.list({
          collection,
          country,
          lang,
          num: limit
        }),
        30000
      );
      
      results.forEach(app => appIds.add(app.appId));
      console.log(`[Discovery] ${name}: +${results.length} apps (total: ${appIds.size})`);
    } catch (error) {
      console.warn(`[Discovery] Error fetching ${name}: ${error.message}`);
    }
  }
  
  return appIds;
}

// Discover apps from categories
async function discoverFromCategories(country, lang, limit = 200) {
  const appIds = new Set();
  console.log(`[Discovery] Fetching categories...`);
  
  for (const category of CATEGORIES) {
    try {
      console.log(`[Discovery] Fetching category ${category}...`);
      const results = await fetchWithTimeout(() =>
        gplay.list({
          category,
          collection: gplay.collection.TOP_FREE,
          country,
          lang,
          num: limit
        }),
        30000
      );
      
      results.forEach(app => appIds.add(app.appId));
      console.log(`[Discovery] ${category}: +${results.length} apps (total: ${appIds.size})`);
    } catch (error) {
      console.warn(`[Discovery] Error fetching category ${category}: ${error.message}`);
    }
  }
  
  return appIds;
}

// Discover apps from keyword searches
async function discoverFromKeywords(country, lang, limit = 100) {
  const appIds = new Set();
  console.log(`[Discovery] Fetching from keyword searches...`);
  
  for (const keyword of PROBLEM_KEYWORDS) {
    try {
      console.log(`[Discovery] Searching: "${keyword}"...`);
      const results = await fetchWithTimeout(() =>
        gplay.search({
          term: keyword,
          country,
          lang,
          num: limit
        }),
        30000
      );
      
      results.forEach(app => appIds.add(app.appId));
      console.log(`[Discovery] "${keyword}": +${results.length} apps (total: ${appIds.size})`);
    } catch (error) {
      console.warn(`[Discovery] Error searching "${keyword}": ${error.message}`);
    }
  }
  
  return appIds;
}

// Parse installs range to upper bound
function parseInstallsUpper(installs) {
  if (!installs || typeof installs !== 'string') return 0;
  
  // Format: "1,000+" or "1,000,000+" or "500,000+"
  const match = installs.match(/([\d,]+)\+/);
  if (match) {
    return parseInt(match[1].replace(/,/g, ''), 10);
  }
  
  // Format: "100,000 - 500,000"
  const rangeMatch = installs.match(/([\d,]+)\s*-\s*([\d,]+)/);
  if (rangeMatch) {
    return parseInt(rangeMatch[2].replace(/,/g, ''), 10);
  }
  
  return 0;
}

// Fetch app details
async function fetchAppDetails(appId, country, lang) {
  try {
    const app = await fetchWithTimeout(() =>
      gplay.app({
        appId,
        country,
        lang
      }),
      30000
    );
    
    return {
      appId: app.appId,
      title: app.title,
      developer: app.developer,
      category: app.genre,
      score: app.score,
      ratingsCount: app.reviews || 0,
      installsUpper: parseInstallsUpper(app.installs),
      url: app.url
    };
  } catch (error) {
    throw new Error(`Failed to fetch ${appId}: ${error.message}`);
  }
}

// Calculate exception score
function calculateExceptionScore(details) {
  const { ratingsCount, score, installsUpper } = details;
  
  if (installsUpper === 0) return 0;
  
  const density = ratingsCount / installsUpper;
  
  // Normalize each component to 0-1 range
  const scoreWeight = (score || 0) / 5.0; // 0-1 (4.2+ scores are 0.84+)
  const ratingsWeight = Math.min(Math.log10(ratingsCount + 1) / 6.0, 1.0); // Log scale, capped at 1
  const installsWeight = Math.min(1.0 / (Math.log10(installsUpper + 1) / 5.5), 1.0); // Inverse log (lower = better), capped
  const densityWeight = Math.min(density * 10, 1.0); // Density scaled (0.1 = 1.0, capped at 1)
  
  // Equal weights for all factors
  return (scoreWeight * 0.25) + (ratingsWeight * 0.25) + (installsWeight * 0.25) + (densityWeight * 0.25);
}

// Filter apps
function filterApp(details, config) {
  return details.ratingsCount >= config.minRatings &&
    (details.score || 0) >= config.minScore &&
    details.installsUpper <= config.maxInstallsUpper &&
    details.installsUpper > 0;
}

// Convert to CSV row
function toCSVRow(app) {
  const escape = (str) => {
    if (str === null || str === undefined) return '';
    const s = String(str);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  
  return [
    escape(app.exceptionScore.toFixed(4)),
    escape(app.title),
    escape(app.appId),
    escape(app.developer),
    escape(app.category),
    escape(app.score?.toFixed(2) || ''),
    escape(app.ratingsCount),
    escape(app.installsUpper),
    escape((app.ratingsCount / app.installsUpper * 100).toFixed(2) + '%'),
    escape(app.url)
  ].join(',');
}

// Write outputs
async function writeOutputs(exceptionalApps, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  
  // JSON output
  const jsonPath = path.join(outDir, 'exceptional_apps.json');
  await fs.writeFile(jsonPath, JSON.stringify(exceptionalApps, null, 2));
  console.log(`[Output] Written: ${jsonPath}`);
  
  // CSV output
  const csvPath = path.join(outDir, 'exceptional_apps.csv');
  const csvHeader = 'Exception Score,Title,App ID,Developer,Category,Score,Ratings Count,Installs Upper,Density,URL\n';
  const csvRows = exceptionalApps.map(toCSVRow).join('\n');
  await fs.writeFile(csvPath, csvHeader + csvRows);
  console.log(`[Output] Written: ${csvPath}`);
}

// Main execution
async function main() {
  const config = parseArgs();
  console.log('[Config]', config);
  
  // Ensure output directory exists
  await fs.mkdir(config.outDir, { recursive: true });
  
  const checkpointPath = path.join(config.outDir, 'progress.json');
  const errorLogPath = path.join(config.outDir, 'errors.log');
  const checkpoint = new CheckpointManager(checkpointPath);
  const progress = new ProgressTracker();
  
  // Load checkpoint if exists
  await checkpoint.load();
  
  // Phase 1: Discovery
  console.log('\n=== Phase 1: Discovery ===');
  const discoveredFromCollections = await discoverFromCollections(config.country, config.lang);
  const discoveredFromCategories = await discoverFromCategories(config.country, config.lang);
  const discoveredFromKeywords = await discoverFromKeywords(config.country, config.lang);
  
  // Merge all discovered appIds
  const allDiscovered = new Set([
    ...checkpoint.getDiscovered(),
    ...discoveredFromCollections,
    ...discoveredFromCategories,
    ...discoveredFromKeywords
  ]);
  
  allDiscovered.forEach(id => checkpoint.addDiscovered(id));
  
  console.log(`[Discovery] Total unique appIds: ${allDiscovered.size}`);
  
  // Convert to array and limit
  let candidateAppIds = Array.from(allDiscovered);
  if (candidateAppIds.length > config.maxApps) {
    candidateAppIds = candidateAppIds.slice(0, config.maxApps);
    console.log(`[Discovery] Limited to ${config.maxApps} candidates`);
  }
  
  progress.totalAppIds = candidateAppIds.length;
  
  // Phase 2: Fetch app details
  console.log('\n=== Phase 2: Fetching App Details ===');
  const limit = pLimit(config.concurrency);
  const exceptionalApps = [];
  const errorLog = [];
  
  const processApp = async (appId) => {
    if (checkpoint.isProcessed(appId)) {
      const existing = checkpoint.data.appDetails[appId];
      if (existing && filterApp(existing, config)) {
        const score = calculateExceptionScore(existing);
        exceptionalApps.push({ ...existing, exceptionScore: score });
        progress.update({ processed: 1, success: 1, filtered: 1 });
      } else {
        progress.update({ processed: 1 });
      }
      return;
    }
    
    try {
      const details = await retry(() => 
        fetchAppDetails(appId, config.country, config.lang)
      );
      
      checkpoint.markProcessed(appId, details);
      
      if (filterApp(details, config)) {
        const score = calculateExceptionScore(details);
        exceptionalApps.push({ ...details, exceptionScore: score });
        progress.update({ processed: 1, success: 1, filtered: 1 });
      } else {
        progress.update({ processed: 1, success: 1 });
      }
      
      // Save checkpoint periodically
      if (progress.shouldCheckpoint()) {
        await checkpoint.save();
      }
    } catch (error) {
      const errorMsg = `${new Date().toISOString()} - ${appId}: ${error.message}\n`;
      errorLog.push(errorMsg);
      progress.update({ processed: 1, fail: 1 });
      
      // Save errors periodically
      if (errorLog.length % 10 === 0) {
        await fs.appendFile(errorLogPath, errorLog.join(''));
        errorLog.length = 0;
      }
    }
  };
  
  // Process all apps with concurrency limit
  const promises = candidateAppIds.map(appId => 
    limit(() => processApp(appId))
  );
  
  await Promise.all(promises);
  
  // Final checkpoint and error log
  await checkpoint.save();
  if (errorLog.length > 0) {
    await fs.appendFile(errorLogPath, errorLog.join(''));
  }
  
  progress.finalPrint();
  
  // Phase 3: Sort and output
  console.log('\n=== Phase 3: Sorting and Output ===');
  exceptionalApps.sort((a, b) => b.exceptionScore - a.exceptionScore);
  
  await writeOutputs(exceptionalApps, config.outDir);
  
  // Print top 30
  console.log('\n=== Top 30 Exceptional Apps ===\n');
  const top30 = exceptionalApps.slice(0, 30);
  top30.forEach((app, idx) => {
    console.log(`${idx + 1}. ${app.title} (${app.appId})`);
    console.log(`   Score: ${app.exceptionScore.toFixed(4)} | Rating: ${app.score?.toFixed(2) || 'N/A'} | ` +
      `Ratings: ${app.ratingsCount.toLocaleString()} | Installs: ${app.installsUpper.toLocaleString()} | ` +
      `Density: ${(app.ratingsCount / app.installsUpper * 100).toFixed(2)}%`);
    console.log(`   URL: ${app.url}\n`);
  });
  
  console.log(`[Complete] Found ${exceptionalApps.length} exceptional apps out of ${candidateAppIds.length} candidates`);
}

// Run
main().catch(error => {
  console.error('[Fatal Error]', error);
  process.exit(1);
});

