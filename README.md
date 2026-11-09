# RefDelta

## Files

### lib/wayback.ts

CDX lookup via findLatestSnapshot()
asks Wayback for the most recent snapshot of a URL; returns { timestamp, statusCode, snapshotUrl }, or null if there's no snapshot
Snapshot download via fetchSnapshotHtml()
downloads the raw archived HTML (the id_ flag in the URL means "as originally captured", without Wayback's toolbar)
^^ both requests are through waybackFetch(), defined in lib/waybackRateLimit.ts

### lib/waybackRateLimit.ts: through which all Wayback requests are made

Exports waybackFetch(url, kind), which is used for running any request to the Wayback Machine
kind is 'lookup' (CDX) or 'download' (snapshot HTML)
Runs all requests, paced for rate-limiting purposes
Lookups at least 2.5s apart and downloads about 132ms apart. Several requests can be in flight at once. [source; defaults, set with Internet Archive staff, are 80% of the hard limits: CDX 30/min, downloads 600/min]
On a 429 (rate-limited error), saves a “blocked until” time to prevent sending any more requests to the Wayback Machine (doing so can get our IP temporarily blocked/banned)
Also exports:
WaybackRateLimitedError: the error thrown on a 429 and while paused, so callers can stop
waitForFreeSlot(kind): used by the L1 link loop in background.ts to start one lookup per slot
All other functions are internal helpers
All Wayback lookups and snapshot downloads go through waybackFetch()
Note that an L1 link that itself points to web.archive.org is currently fetched directly… this would contribute to request limits?

### lib/linkDiff.ts

diffLink(link, snapshot): checks + diffs one L1 link (a link found on the page being analyzed)
Fetches live page (not through Wayback, so not rate-limited) (raw HTML, before any JavaScript runs)
Classifies result of each fetch:
link rot: error status (404, 410, 500, …) or site unreachable (e.g. domain gone). Not diffed
except 401 / 403 / 429 (login / bot protection / rate limit), which don't tell us whether the page is gone
skipped: the live page isn't known to be gone, but can't be diffed: no snapshot, not an HTML page (e.g. PDF), or blocked (401/403/429)
error: live page timed out (30s), or snapshot download failed
diffed: downloads the snapshot (fetchSnapshotHtml()), then computes each strategy's L1 differ's similarity on (snapshot HTML, live HTML) via measureL1Similarities() in lib/metrics.ts; no full diff is kept; to see one, the user opens the link and clicks Analyze on that L1 page
NOTE: unrelated redirects not yet handled properly (ran into issues like youtu.be redirecting to youtube being flagged as an unrelated redirect; conversely if we just hard-code a bunch of URL parking sites it might be cumbersome/not cover everything…); we could maybe use redirected + very low similarity to the snapshot as a metric for classifying whether we have redirected to a completely different site?
Also reports which step it's on (onPhase), for the status badges in the popup

### entrypoints/background.ts

The whole pipeline, in order, run when you click Analyze (analyzeTab())
Asks the content script (entrypoints/content.ts) for the open page: parsed content (extract()) + its full HTML
CDX lookup for the page (findLatestSnapshot())
Snapshot download (fetchSnapshotHtml()), then runs each strategy's L0 differ on (snapshot, live page) (measureL0Diffs() in lib/metrics.ts)
For the first MAX_LINKS (50; TODO: get rid of cap entirely) links on the page (analyzeLinks()): starts one lookup per free lookup slot; each link whose lookup succeeded (even if it found no snapshot) goes through diffLink()
After every step, saves results to storage.session (update()) (TODO: use IndexedDB); the popup redraws whenever they change; analysis keeps going if the popup is closed
The shape of the saved results is Analysis in lib/analysis.ts

### entrypoints/popup/main.ts: only displays results; does no analysis

### lib/parse/: the shared parser (HTML → the page's main text)

extract(doc, url) (extract.ts) returns the page's content: blocks (the text of each paragraph / heading / list item in the main content, in order), plus links, images, the title and the boilerplate it removed
Boilerplate (menus, headers, footers, sidebars, etc.) is removed by tag rules
Kohlschütter's classifier (kohlschutter.ts) is an extra option that's off by default
Why it’s off: upon initial testing on mit.edu, it dropped short teaser blurbs under the news headlines, which are real content
^^ Haven’t done further work on this yet to figure out how to make it work better
parseHtml(html) (html.ts) turns an HTML string into a document extract() can read
uses the linkedom library, because the browser's DOMParser doesn't exist in the background script, which is where the diff algorithms run
htmlToBlocks(html) (html.ts): HTML string → the page's text blocks, using parseHtml() + extract(). Text-based differs should use this



DIFFING ALGORITHMS

Each diff algorithm / differ compares two versions of a page: the snapshot (old) and the live page (new). Every differ gets the same two HTML strings and outputs:
Diff: what changed, in whatever customized format suits that algorithm
Similarity: a number from 0 to 1, where 1 = identical and 0 = nothing in common

### lib/metrics.ts: where differs are called from

STRATEGIES: the list of strategies; each strategy (DiffStrategy) is a pair of differs: { L0, L1 }
L0: runs on the main page being analyzed; full diff + similarity
L1: runs on each L1 link; similarity only (to see a link's full diff, the user should open the link and click Analyze, and this would be the L0 for the new analysis)
Usually strategies would use the same algorithm for both (e.g. { L0: new MyersDiffer('word'), L1: new MyersDiffer('word') }), but they can differ (e.g. we could try Myers on the L0 page, a cheaper algorithm on L1 links)
For now, every strategy in this list runs; each differ runs only once per page, even if several strategies use it (differs are told apart by name)
TODO: Allow user to select the one algorithm (or multiple? idk, design decision) that they want to run
measureL0Diffs(snapshotHtml, liveHtml): runs each strategy's L0 differ's compare() on the L0 page (full diff + similarity, with previews)
measureL1Similarities(snapshotHtml, liveHtml): runs each strategy's L1 differ's similarity() on every L1 link (similarity only, no diff kept)
Whether that needs a full diff internally depends on the algorithm: Myers computes one to get its similarity; Shingling + Jaccard doesn't
Each differ runs inside a try/catch: if yours throws, its row in the popup shows the error (on a link, it just says <algorithm> failed), and the other differs still run

### lib/diff/differ.ts: Differ class; every algorithm is a class that extends it

Differ<R, D>: R = what your algorithm compares (its "representation"); D = what your diff looks like
You write these methods:
name: shown in the popup (e.g. 'myers-word'); must be unique
parse(html): HTML string → your representation R. Called once for each page
computeDiff(oldRep, newRep): returns a DiffResult: { algorithm: this.name, diff, stats: { sizeBytes } }
sizeBytes = size of the diff as JSON (new TextEncoder().encode(JSON.stringify(diff)).length), so diff sizes can be compared across algorithms
computeSimilarity(oldRep, newRep, diff?): returns 0-1
diff is passed in when a diff was just computed (L0 page), so you can reuse it if your similarity comes from the diff (Myers does)
Must also work when diff is undefined: similarity() calls it without one, which is what happens for every L1 link
Handle empty pages: if both are empty, return 1 (don't divide by 0)
preview(diff) (optional): a short readable version of your diff for the popup: a list of { op: 'equal' | 'insert' | 'delete', text }.
Can use MAX_RUNS and shortenRun() helper from preview.ts to help keep it short
Skip it and the popup just shows no preview; no biggie
You don't write or change these (the base class does them):
compare(oldHtml, newHtml): runs parse (both pages) → computeDiff → computeSimilarity
similarity(oldHtml, newHtml): runs parse → computeSimilarity only (no diff)
^^ NOTE: both compute the time taken for each step for our own performance analysis purposes
^^ Both also label the page (unchanged / minor / major) from its similarity, using ThresholdClassifier (lib/classify/threshold.ts). You don't need to write anything for this; every differ gets it by default
The default thresholds (≥ 0.99 = unchanged, ≥ 0.8 = minor, below that = major) are placeholders, to be set by experiments
The same score can mean different things for different algorithms, so you can set your own: add a constructor to your class that calls super(new ThresholdClassifier({ unchanged: 0.95, minor: 0.6 }))
See lib/diff/myers.ts as an example
The popup shows a separate time for each method (parse / diff / similarity columns), and each L1 link shows a total + computing time, so write each piece of code in the method it belongs to, as explained above. Again, as a summary:
parse(): HTML → tokens
computeDiff(): Working out what changed in computeDiff,
computeSimilarity(): calculating the similarity score
e.g. if you ran your diff inside parse, the popup would show a slow parse and a fast diff, which would make the timing comparison between algorithms misleading

### lib/diff/diff-interfaces.ts: Representations; what parse() can return

TextRep: { kind: 'text', tokens: string[] }, a flat list of words, blocks, etc. Use this for text-based algorithms (shingling, FastCDC)
Build the tokens from htmlToBlocks()
TreeRep: the page as a tree of elements, for X-Diff / BULD. Nothing builds this yet: a page → tree parser has to be written first
In your algorithm PR, only change your own file + your one line in STRATEGIES
NOTE: If you think something belongs in the shared code (differ.ts, diff-interfaces.ts, preview.ts, metrics.ts, lib/parse/), like a helper several algorithms could use or the page → tree parser, feel free to add it as a small separate PR or commit on main

EXAMPLE: lib/diff/myers.ts; Myers
Two versions, each its own strategy in STRATEGIES (same differ for L0 and L1): myers-word (tokens = words) and myers-block (tokens = whole blocks)
parse(html): turns the HTML string into a list of tokens
htmlToBlocks(html): runs the shared parser and returns the page's text blocks (paragraphs, headings, list items), with boilerplate removed
myers-word splits the blocks into words; myers-block keeps each block as one token
computeDiff: diffArrays(oldTokens, newTokens) from the diff npm package (Myers' algorithm) → the old text turned into the new one as runs of equal / inserted / deleted tokens, plus a count of each
computeSimilarity: 2 * equal / (old tokens + new tokens). Uses the diff's counts if given (L0 page), otherwise runs the diff itself (L1 links)
e.g. old = "a b c d", new = "a b x d" → 3 equal tokens, 8 total → 2 * 3/8 = 75%
preview: the runs, shortened

## GUIDES

### Adding a diff algorithm (full template in lib/diff/README.md)
Branch off the latest main: git checkout main && git pull && npm install && git checkout -b <your-name>/<algorithm>
Create lib/diff/<name>.ts: copy the template from lib/diff/README.md (or start from myers.ts) and fill in name, parse, computeDiff, computeSimilarity and optionally preview
Add one line at the end of STRATEGIES in lib/metrics.ts: { L0: new MyDiffer(), L1: new MyDiffer() }, (plus the import at the top of that file)
To try your algorithm only on L1 links, pair it with an existing L0 differ instead, e.g. { L0: new MyersDiffer('word'), L1: new MyDiffer() },
Run npm run compile. It checks for type errors and shouldn't report any
Run npm run dev. This builds the extension and opens a browser with it loaded (it also reloads when you save)
Open any page (that’s likely on Wayback), click the extension icon, click Analyze this page, and check:
"Differ metrics" table: a row for your algorithm with times, diff size, similarity and label (or an error message if it threw), if it's an L0 differ
Your diff preview below the table (if you wrote preview)
L1 link list: each diffed link shows your algorithm's similarity next to Myers', if it's an L1 differ. This also checks that your computeSimilarity works without a diff.
NOTE: Only change your own file + your one line in STRATEGIES. No need to edit differ.ts, diff-interfaces.ts, preview.ts, metrics.ts (except that line) or lib/parse/, which are shared by every algorithm (unless adding shared resources / making shared fixes, etc.)
