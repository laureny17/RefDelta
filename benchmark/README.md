# Benchmarks

Run automated testing on URLs specified in playwright.ts.

## Parameters

1. Similarity only versus full diff construction
2. Diff algorithm used


## Usage
Current algorithms options are hardcoded
- Specify output path identifier with --name

```
# Run ONLY myers-word (cleaner timing data, 2x faster)
npm run benchmark:playwright -- --algorithm myers-word --name word-only

# Run ONLY myers-block
npm run benchmark:playwright -- --algorithm myers-block --name block-only

# Run BOTH (default)
npm run benchmark:playwright -- --name both-algorithms
```
