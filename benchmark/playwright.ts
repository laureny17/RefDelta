// Playwright-based end-to-end benchmark
// Runs the actual extension in a real browser and collects metrics
// Run with: npm run benchmark:playwright [--output]

import { chromium, type BrowserContext } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'output');

const EXTENSION_PATH = path.join(__dirname, '../.output/chrome-mv3');

interface TestCase {
  id: string;
  url: string;
  expectedChange?: 'unchanged' | 'minor' | 'major';
}

const TEST_CASES: TestCase[] = [
  { id: 'example', url: 'https://example.com/' },
  { id: 'wikipedia-main', url: 'https://en.wikipedia.org/wiki/Main_Page' },
  { id: 'google', url: 'https://www.google.com/' },
  { id: 'mit', url: 'https://www.mit.edu/' },
];

interface BenchmarkResult {
  id: string;
  url: string;
  success: boolean;
  error?: string;
  analysis?: {
    snapshot?: {
      timestamp: string;
      statusCode: string;
    };
    timings: {
      pageMs?: number;
      snapshotLookupMs?: number;
      snapshotDownloadMs?: number;
      differsMs?: number;
      linkLookupsMs?: number;
      totalMs?: number;
    };
    differMetrics?: Array<{
      algorithm: string;
      label: string;
      similarity: number;
      timings: {
        parseMs: number;
        diffMs: number;
        similarityMs: number;
      };
      sizeBytes: number;
    }>;
    linkStats?: {
      total: number;
      analyzed: number;
      stopped?: string;
    };
    linkMetrics?: Array<{
      url: string;
      lookup?: {
        snapshot?: {
          timestamp: string;
          statusCode: string;
          snapshotUrl: string;
        } | null;
        error?: string;
        durationMs: number;
      };
      diff?: {
        live?: {
          status: number;
          redirectedTo?: string;
        };
        rot?: string;
        skipped?: string;
        error?: string;
        metrics?: Array<
          | {
              algorithm: string;
              label: string;
              similarity: number;
              timings: {
                parseMs: number;
                similarityMs: number;
              };
            }
          | { algorithm: string; error: string }
        >;
        durationMs: number;
      };
    }>;
  };
}

async function setupBrowser() {
  console.log('Starting browser with extension...');

  const context = await chromium.launchPersistentContext('', {
    headless: false, // Extensions require headed mode
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });

  return context;
}

async function analyzeUrl(context: BrowserContext, testCase: TestCase): Promise<BenchmarkResult> {
  const result: BenchmarkResult = {
    id: testCase.id,
    url: testCase.url,
    success: false,
  };

  try {
    console.log(`  [1/5] Opening new page...`);
    const page = await context.newPage();

    console.log(`  [2/5] Navigating to ${testCase.url}...`);
    const navStart = performance.now();
    await page.goto(testCase.url, { waitUntil: 'domcontentloaded' });
    console.log(`       ✓ Navigation complete (${(performance.now() - navStart).toFixed(0)}ms)`);

    console.log(`  [3/5] Getting extension service worker...`);
    const serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      throw new Error('Extension service worker not found');
    }

    console.log(`  [4/5] Getting tab ID...`);
    const tabId = await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0]?.id;
    });

    if (!tabId) {
      throw new Error('Could not get tab ID');
    }
    console.log(`       ✓ Tab ID: ${tabId}`);

    console.log(`  [5/5] Triggering analysis...`);

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Call the analyzeTab function in the background script through its global scope
    const triggered = await serviceWorker.evaluate(async (id) => {
      try {
       
        const listeners = chrome.runtime.onMessage.hasListeners();
        if (listeners) {
          // Manually call the listener with the message
          chrome.runtime.onMessage.hasListeners(); // This returns true if there are listeners
          return false;
        }
        return false;
      } catch (e) {
        console.error('Error triggering analysis:', e);
        return false;
      }
    }, tabId);

    if (!triggered) {
      const extensionId = await serviceWorker.evaluate(() => chrome.runtime.id);
      const popupUrl = `chrome-extension://${extensionId}/popup.html?tab=${tabId}`;
      const popup = await context.newPage();
      await popup.goto(popupUrl);
      await popup.waitForSelector('#analyze', { timeout: 5000 });
      await popup.click('#analyze');
      await new Promise(resolve => setTimeout(resolve, 500));
      await popup.close();
      console.log(`       ✓ Analysis triggered via popup`);
    } else {
      console.log(`       ✓ Analysis triggered directly`);
    }

    // Poll for analysis completion
    console.log(`  [6/6] Polling for analysis results...`);
    const analysisKey = `analysis:${tabId}`;
    let analysis: any = null;
    let attempts = 0;
    const maxAttempts = 120; // 2 minutes max
    let lastStatus = '';

    while (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;

      analysis = await serviceWorker.evaluate((key) => {
        return new Promise((resolve) => {
          chrome.storage.session.get(key, (result) => resolve(result[key]));
        });
      }, analysisKey);

      if (!analysis) {
        if (attempts === 1 || attempts % 5 === 0) {
          console.log(`       [${attempts}s] ⏳ Waiting for analysis to start...`);
        }
        continue;
      }

      // Build progress status with visual indicators
      const steps = [];
      if (analysis.livePage) {
        steps.push('✓ Page');
      } else {
        steps.push('⏳ Page');
      }

      if (analysis.snapshot !== undefined) {
        steps.push(analysis.snapshot ? '✓ Snapshot' : '✓ No-snap');
      } else if (analysis.snapshotError) {
        steps.push('❌ Snapshot');
      } else {
        steps.push('⏳ Snapshot');
      }

      if (analysis.differMetrics) {
        steps.push('✓ Differs');
      } else if (analysis.metricsError) {
        steps.push('❌ Differs');
      } else if (analysis.snapshot) {
        steps.push('⏳ Differs');
      }

      if (analysis.linkLookups) {
        const count = Object.keys(analysis.linkLookups).length;
        const total = analysis.linksToLookUp?.length || 0;
        steps.push(`⏳ Links(${count}/${total})`);
      } else if (analysis.linksToLookUp) {
        steps.push('⏳ Links(0/?)');
      }

      const status = steps.join(' | ');
      if (status !== lastStatus || attempts % 5 === 0) {
        console.log(`       [${attempts}s] ${status}`);
        lastStatus = status;
      }

      // Check if analysis is complete
      const snapshotDone = analysis.snapshot !== undefined;
      const differsDone = !analysis.snapshot || analysis.differMetrics !== undefined || analysis.metricsError !== undefined;

      // Links are done when: stopped, or all links looked up
      const linksStarted = analysis.linksToLookUp !== undefined;
      const allLinksLookedUp = linksStarted &&
        analysis.linksToLookUp!.length === Object.keys(analysis.linkLookups || {}).length;
      const linksStopped = analysis.linkLookupsStopped !== undefined;
      const linksDone = linksStarted && (allLinksLookedUp || linksStopped);

      if (snapshotDone && differsDone && linksDone) {
        console.log(`       ✅ Complete!`);
        break;
      }
    }

    if (!analysis) {
      throw new Error('Analysis timed out');
    }

    result.success = true;
    result.analysis = {
      snapshot: analysis.snapshot
        ? {
            timestamp: analysis.snapshot.timestamp,
            statusCode: analysis.snapshot.statusCode,
          }
        : undefined,
      timings: {
        pageMs: analysis.times?.page,
        snapshotLookupMs: analysis.times?.snapshotLookup,
        snapshotDownloadMs: analysis.times?.snapshotDownload,
        differsMs: analysis.times?.differs,
        linkLookupsMs: analysis.times?.linkLookups,
        totalMs: analysis.times?.total,
      },
      differMetrics: analysis.differMetrics?.map((m: any) => ({
        algorithm: m.algorithm,
        label: m.label,
        similarity: m.similarity,
        timings: m.timings,
        sizeBytes: m.sizeBytes,
      })),
      linkStats: {
        total: analysis.linksToLookUp?.length || 0,
        analyzed: Object.keys(analysis.linkLookups || {}).length,
        stopped: analysis.linkLookupsStopped,
      },
      linkMetrics: analysis.linksToLookUp?.map((url) => {
        const lookup = analysis.linkLookups?.[url];
        const diff = analysis.linkDiffs?.[url];

        return {
          url,
          lookup: lookup
            ? 'error' in lookup
              ? { error: lookup.error, durationMs: lookup.durationMs }
              : {
                  snapshot: lookup.snapshot
                    ? {
                        timestamp: lookup.snapshot.timestamp,
                        statusCode: lookup.snapshot.statusCode,
                        snapshotUrl: lookup.snapshot.snapshotUrl,
                      }
                    : null,
                  durationMs: lookup.durationMs,
                }
            : undefined,
          diff: diff
            ? 'error' in diff
              ? { error: diff.error, durationMs: diff.durationMs }
              : 'rot' in diff
                ? {
                    live: diff.live,
                    rot: diff.rot,
                    durationMs: diff.durationMs,
                  }
                : 'skipped' in diff
                  ? {
                      live: diff.live,
                      skipped: diff.skipped,
                      durationMs: diff.durationMs,
                    }
                  : {
                      live: diff.live,
                      metrics: diff.metrics.map((m: any) => ('error' in m
                        ? { algorithm: m.algorithm, error: m.error }
                        : {
                            algorithm: m.algorithm,
                            label: m.label,
                            similarity: m.similarity,
                            timings: {
                              parseMs: m.timings.parseMs,
                              similarityMs: m.timings.similarityMs,
                            },
                          }
                      )),
                      durationMs: diff.durationMs,
                    }
            : undefined,
        };
      }),
    };

    console.log('\n  === Results ===');
    if (analysis.snapshot) {
      console.log(`  Snapshot: ${analysis.snapshot.timestamp} (status: ${analysis.snapshot.statusCode})`);
    } else if (analysis.snapshotError) {
      console.log(`  Snapshot error: ${analysis.snapshotError}`);
    } else {
      console.log(`  No snapshot found`);
    }

    if (analysis.differMetrics) {
      console.log('\n  Differ results:');
      analysis.differMetrics.forEach((m: any) => {
        console.log(`    • ${m.algorithm}: ${m.label} (similarity=${m.similarity.toFixed(3)})`);
        console.log(
          `      Timings: parse=${m.timings.parseMs.toFixed(1)}ms, diff=${m.timings.diffMs.toFixed(1)}ms, sim=${m.timings.similarityMs.toFixed(1)}ms`
        );
        console.log(`      Size: ${m.sizeBytes} bytes`);
      });
    } else if (analysis.metricsError) {
      console.log(`  Differ error: ${analysis.metricsError}`);
    }

    if (result.analysis.linkStats) {
      console.log(`\n  Links: ${result.analysis.linkStats.analyzed}/${result.analysis.linkStats.total} analyzed`);
      if (result.analysis.linkStats.stopped) {
        console.log(`  Link analysis stopped: ${result.analysis.linkStats.stopped}`);
      }
    }

    if (result.analysis.timings.totalMs) {
      console.log(`\n  ⏱️  Total pipeline time: ${result.analysis.timings.totalMs.toFixed(0)}ms`);
      if (result.analysis.timings.pageMs) {
        console.log(`      Page extraction: ${result.analysis.timings.pageMs.toFixed(0)}ms`);
      }
      if (result.analysis.timings.snapshotLookupMs) {
        console.log(`      Snapshot lookup: ${result.analysis.timings.snapshotLookupMs.toFixed(0)}ms`);
      }
      if (result.analysis.timings.snapshotDownloadMs) {
        console.log(`      Snapshot download: ${result.analysis.timings.snapshotDownloadMs.toFixed(0)}ms`);
      }
      if (result.analysis.timings.differsMs) {
        console.log(`      Differs: ${result.analysis.timings.differsMs.toFixed(0)}ms`);
      }
      if (result.analysis.timings.linkLookupsMs) {
        console.log(`      Link lookups: ${result.analysis.timings.linkLookupsMs.toFixed(0)}ms`);
      }
    }

    await page.close();
  } catch (err) {
    result.error = String(err);
    console.log(`  ❌ Error: ${err}`);
  }

  return result;
}

async function runPlaywrightBenchmark(saveOutput: boolean = false) {
  console.log('=== Playwright End-to-End Benchmark ===\n');

  // Check if extension is built
  console.log(`Checking for extension at: ${EXTENSION_PATH}`);
  try {
    await fs.access(EXTENSION_PATH);
    console.log('✓ Extension found\n');
  } catch {
    console.error(`❌ Extension not found at ${EXTENSION_PATH}`);
    console.error('Please run: npm run build');
    process.exit(1);
  }

  const context = await setupBrowser();
  const results: BenchmarkResult[] = [];

  try {
    console.log(`\nRunning ${TEST_CASES.length} test cases...\n`);
    console.log('='.repeat(70));

    for (let i = 0; i < TEST_CASES.length; i++) {
      const testCase = TEST_CASES[i];
      console.log(`\n[${i + 1}/${TEST_CASES.length}] ${testCase.id}: ${testCase.url}`);
      console.log('-'.repeat(70));

      const result = await analyzeUrl(context, testCase);
      results.push(result);

      await fs.mkdir(OUTPUT_DIR, { recursive: true });
      const individualFile = path.join(OUTPUT_DIR, `${testCase.id}-latest.json`);
      await fs.writeFile(individualFile, JSON.stringify(result, null, 2));
      console.log(`\n  💾 Saved to: ${individualFile}`);

      // Delay between tests
      if (i < TEST_CASES.length - 1) {
        console.log('\n  ⏸️  Waiting 3s before next test...');
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    console.log('\n' + '='.repeat(70));
  } finally {
    console.log('\nClosing browser...');
    await context.close();
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('=== SUMMARY ===\n');

  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log(`Results: ${successful} successful, ${failed} failed (${TEST_CASES.length} total)\n`);

  if (failed > 0) {
    console.log('Failed tests:');
    results.filter((r) => !r.success).forEach((r) => {
      console.log(`  ❌ ${r.id}: ${r.error}`);
    });
    console.log('');
  }

  if (successful > 0) {
    const successfulResults = results.filter((r) => r.success && r.analysis);

    // Average timings
    const avgTimings = {
      page: 0,
      snapshotLookup: 0,
      snapshotDownload: 0,
      differs: 0,
      total: 0,
    };

    let count = 0;
    successfulResults.forEach((r) => {
      if (r.analysis?.timings) {
        avgTimings.page += r.analysis.timings.pageMs || 0;
        avgTimings.snapshotLookup += r.analysis.timings.snapshotLookupMs || 0;
        avgTimings.snapshotDownload += r.analysis.timings.snapshotDownloadMs || 0;
        avgTimings.differs += r.analysis.timings.differsMs || 0;
        avgTimings.total += r.analysis.timings.totalMs || 0;
        count++;
      }
    });

    if (count > 0) {
      console.log('Average timings (L0 page analysis):');
      console.log(`  Page extraction:    ${(avgTimings.page / count).toFixed(0).padStart(6)}ms`);
      console.log(`  Snapshot lookup:    ${(avgTimings.snapshotLookup / count).toFixed(0).padStart(6)}ms`);
      console.log(`  Snapshot download:  ${(avgTimings.snapshotDownload / count).toFixed(0).padStart(6)}ms`);
      console.log(`  Differs:            ${(avgTimings.differs / count).toFixed(0).padStart(6)}ms`);
      console.log(`  ────────────────────────────`);
      console.log(`  Total:              ${(avgTimings.total / count).toFixed(0).padStart(6)}ms`);
      console.log('');
    }

    // Per-algorithm accuracy (if ground truth provided)
    const algorithmsWithLabels = new Map<string, { correct: number; total: number }>();
    successfulResults.forEach((r) => {
      const testCase = TEST_CASES.find((tc) => tc.id === r.id);
      if (testCase?.expectedChange && r.analysis?.differMetrics) {
        r.analysis.differMetrics.forEach((m: any) => {
          if (!algorithmsWithLabels.has(m.algorithm)) {
            algorithmsWithLabels.set(m.algorithm, { correct: 0, total: 0 });
          }
          const stat = algorithmsWithLabels.get(m.algorithm)!;
          stat.total++;
          if (m.label === testCase.expectedChange) stat.correct++;
        });
      }
    });

    if (algorithmsWithLabels.size > 0) {
      console.log('Accuracy (vs. expected):');
      algorithmsWithLabels.forEach((stat, algo) => {
        const pct = ((stat.correct / stat.total) * 100).toFixed(0);
        console.log(`  ${algo}: ${stat.correct}/${stat.total} (${pct}%)`);
      });
      console.log('');
    }
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const combinedFile = path.join(OUTPUT_DIR, `playwright-${timestamp}.json`);
  await fs.writeFile(combinedFile, JSON.stringify(results, null, 2));
  console.log(`💾 All results saved to: ${combinedFile}`);

  const latestFile = path.join(OUTPUT_DIR, 'playwright-latest.json');
  await fs.writeFile(latestFile, JSON.stringify(results, null, 2));
  console.log(`💾 Latest results: ${latestFile}\n`);
}

const saveOutput = process.argv.includes('--output');
runPlaywrightBenchmark(saveOutput).catch(console.error);
