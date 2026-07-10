# Tests Agent Guide

## Purpose

Tests are Playwright-based and should exercise production behavior. Avoid stubs, mocks, or synthetic state injection in eval-style tests unless a specific unit-style fixture already exists for that test.

## Commands

```bash
bun install
bunx playwright install chromium
bun run test:e2e
```

Useful debug commands:

```bash
npx playwright test --debug
PWDEBUG=1 npx playwright test
HEADLESS=false npx playwright test
```

## Rules

- Real API keys come from env.
- Real backend and real external APIs are expected for live tests.
- `page.evaluate()` may read state but should not inject data or bypass user flow in eval tests.
- Empty/black panels where real map or panorama content should render mean the eval is broken.
- After a run, inspect traces, console logs, screenshots/videos, and failed requests before reporting results.

## Test Areas

- `tests/area-scan*.spec.js` - area scan and live scan behavior.
- `tests/detection.e2e.spec.js` - detection workflow behavior.
- `tests/mass-ave-ocr*.spec.js` - live OCR/eval coverage.
- `tests/ocr-pipeline-deterministic.spec.js` - deterministic OCR pipeline expectations.
- `tests/streets-intersection.e2e.spec.js` - production street intersection logic with fixtures.
