# Play Scrape - Dhanda-like App Discovery Tool

A Node.js (ESM) CLI tool that discovers Google Play apps with high rating counts and low installs (similar to Dhanda apps) in a fully automated, repeatable way.

## Features

- **Multiple Discovery Sources**: Collects appIds from Google Play collections, category top lists, and keyword searches
- **Robust & Resumable**: Progress checkpoints allow resuming interrupted runs
- **Concurrent Processing**: Configurable concurrency for efficient processing
- **Comprehensive Filtering**: Filters apps based on ratings count, score, and installs
- **Exception Score**: Calculates a composite score prioritizing high ratings, low installs, and high density
- **Progress Tracking**: Real-time progress updates with ETA
- **Error Handling**: Retries with backoff, error logging, never hangs

## Installation

```bash
npm install
```

## Usage

### Run with defaults

```bash
npm start
```

This uses the following defaults:
- Country: `in` (India)
- Language: `en` (English)
- Max Apps: `5000`
- Concurrency: `8`
- Min Ratings: `5000`
- Min Score: `4.2`
- Max Installs Upper: `500000`
- Output Directory: `./out`

### Run with custom thresholds

```bash
node index.mjs --country in --lang en --maxApps 10000 --concurrency 10 --minRatings 10000 --minScore 4.5 --maxInstallsUpper 1000000 --outDir ./results
```

### CLI Flags

- `--country <code>` - Country code (default: `in`)
- `--lang <code>` - Language code (default: `en`)
- `--maxApps <number>` - Maximum number of apps to process (default: `5000`)
- `--concurrency <number>` - Number of concurrent requests (default: `8`)
- `--minRatings <number>` - Minimum ratings count (default: `5000`)
- `--minScore <number>` - Minimum rating score (default: `4.2`)
- `--maxInstallsUpper <number>` - Maximum installs upper bound (default: `500000`)
- `--outDir <path>` - Output directory (default: `./out`)

## Output

The tool generates the following files in the output directory:

- **`exceptional_apps.json`** - Full results in JSON format, sorted by exception score (descending)
- **`exceptional_apps.csv`** - Same results in CSV format
- **`progress.json`** - Checkpoint file for resuming interrupted runs
- **`errors.log`** - Log of errors encountered during processing

The top 30 exceptional apps are also printed to the terminal at the end.

## Discovery Sources

The tool discovers apps from:

1. **Collections**: Top Free, Top Paid, Top Grossing
2. **Categories**: Business, Finance, Productivity, Tools (top free lists)
3. **Keyword Searches**: khata, udhaar, ledger, billing, invoice, inventory, shop, dhanda, attendance, accounting, expenses, cashbook, expense tracker, bookkeeping, pos, payment

## Exception Score

The exception score is calculated using:
- Rating score (25% weight)
- Ratings count (25% weight)
- Inverse installs (25% weight - lower installs = higher score)
- Density = ratingsCount / installsUpperBound (25% weight)

Apps are filtered to only include those meeting:
- `ratingsCount >= minRatings`
- `score >= minScore`
- `installsUpper <= maxInstallsUpper`

## Resumability

The tool saves progress checkpoints:
- Every 50 apps processed
- Every 30 seconds

If you rerun the tool, it will automatically continue from where it left off, skipping already processed apps.

## Requirements

- Node.js 18+ (ESM support)
- Internet connection for Google Play scraping


# play_scrape
