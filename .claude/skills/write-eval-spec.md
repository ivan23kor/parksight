---
name: write-eval-spec
description: Interactive skill that takes a user story about a Parksight feature and produces structured inspector.md + ground-truth.md eval specs through Socratic questioning. Use when user wants to create an eval spec for a feature.
user_invocable: true
---

# Write Eval Spec

You are a spec writer for the Parksight eval system. The user will describe a feature in their own words — a user story, a bug description, or a feature request. Your job is to:

1. Understand their intent through targeted questions
2. Produce two files: `inspector.md` (steps only) and `ground-truth.md` (expectations only)

## Philosophy

Evals describe end-customer behavior, not code paths.

- Every inspector step must correspond to a real user action: click, navigate, scroll, type. If a user can't do it with their hands, it doesn't belong in a step.
- No stubs. No mocks. No synthetic data injection. The app runs with real services — Google Maps, backend YOLO, Overpass.
- If a real API key or service is needed, require it via env var. Fail fast if missing. Never stub the service to avoid needing the key.
- Success = what the end user would see when the feature works. Black/empty panels where real content should appear means the eval is broken, not "fine for testing."
- `page.evaluate()` is for READING state (extracting layer data, checking values). Never use it to WRITE state that bypasses normal UI flow.

## Phase 1: Understand the Feature

Ask the user focused questions to fill gaps. You need to know:

### What the user does (for inspector)
- Which URL/page does the user open?
- What real user actions trigger the feature? (clicks on map, draws selection, taps detect button)
- What real services must be running? (backend, API keys in env)
- What should the user SEE at each step? (describe visual state — panorama imagery, map tiles, colored curves)
- What to screenshot? (full page, zoomed area, specific element)
- What DOM/layer data to extract? (which layers, what properties — read-only observation)

### What the user sees when it works (for ground truth)
- What should be visible? (colors, shapes, positions — as the real user sees them)
- What should NOT be visible? (black panels, empty containers, stub placeholders, no overlaps, no extensions past boundaries)
- Does every visible panel show real content? (Street View imagery, not black; map tiles, not grey)
- What structural properties should hold? (counts, ranges, values)
- What console output is expected? (specific log messages, no errors)

### Parksight-specific knowledge

Use this to ask informed questions:

**Leaflet layers:**
- `signMarkersLayer` — sign dots (green #22c55e), camera dots (blue #60a5fa), road centerlines (amber #f59e0b dashed)
- `ruleCurvesLayer` — parking rule curves colored by category
- `streetsLayer` — street polylines
- `streetViewDotsLayer` — SV coverage dots
- `selectionLayer` — user selection rectangle

**Rule curve colors:**
- no_parking: red #ef4444
- parking_allowed: green #22c55e
- loading_zone: purple #8b5cf6
- permit_required: amber #f59e0b
- tow zones: dashed red #dc2626

**Functions available for data EXTRACTION (read-only observation):**

⚠️ These are for `page.evaluate()` reads ONLY — extracting layer state for report.json.
Never call these to inject data or trigger actions that bypass user interaction.

- `findIntersectionNodes(wayGeometry, allWays)` — reads cross-street intersections
- `findDistanceToNextSign(sign, dir, allSigns, wayGeo, intersections)` — reads distance data
- `buildRuleCurveLatLngs(sign, wayGeo, dir, ruleIndex, maxDist)` — reads curve geometry
- `projectSignToCurbLine(...)` — reads projected sign position

**Reference data (for ground-truth calibration only):**

⚠️ Fixture files are reference data for writing ground-truth assertions.
They are NOT loaded into the browser during the eval. The app fetches its own data from real APIs.

- `tests/fixtures/vassar-street-mit-ways.json` — real OSM data for Vassar/Albany St area (reference)
- Vassar Street way ID 28631895, Albany Street way ID 442971020

**Data flow (observation only):**
- Detection results stored in `localStorage` key `parksight_latest_sign_map_data` — read via `page.evaluate()` after real detection completes
- Never write to localStorage to inject synthetic data

## Phase 2: Generate Specs

After understanding the feature, produce two files.

### `inspector.md` format
```markdown
# Inspector: <feature-name>

## Setup
- Start full stack: `GOOGLE_MAPS_API_KEY=... bun run start` (from /home/ivan23kor/Code/parksight)
- Open: `http://127.0.0.1:8080/?api_key=$GOOGLE_MAPS_API_KEY`
- Fail fast if GOOGLE_MAPS_API_KEY not set
- No fixture loading. No mocking. Real services only.

## Steps
1. <action description>
   ```js
   // page.evaluate code if needed
   ```
   Capture: screenshot `01-description.png`

2. <next action>
   Capture: extract `<layer>._layers.map(l => ({ ... }))`

...
```

### `ground-truth.md` format
```markdown
# Ground Truth: <feature-name>

## Visual assertions
- <what should be visible in screenshots>

## Structural assertions
- <what extracted data should satisfy>

## Screenshot assertions
- <NN-name.png>: <what to check in this specific screenshot>

## Notes on Videos

Videos are recorded automatically but NOT analyzed by the evaluator as part of the standard pipeline. If you want video analysis included, you must:
1. Reference the video file explicitly in an assertion (e.g., "Watch test-<feature>.webm and verify...")
2. Ask a human to request an agent analyze the video

This prevents self-praise bias: the evaluator judges based on structured data (report.json) and visual artifacts, not video narratives.
```

## Phase 3: Save Files

Save to `evals/specs/<feature-name>/inspector.md` and `evals/specs/<feature-name>/ground-truth.md`.

Show both files to the user before saving, ask for confirmation.

## Rules

- Inspector steps must be **unambiguous** — another agent with zero context should execute them without guessing
- Ground truth must be **measurable** — every assertion can be checked against report.json or a screenshot
- Inspector must NEVER contain expectations (no "should", "expect", "correct")
- Ground truth must NEVER contain execution steps (no "click", "navigate", "evaluate")
- Feature name must be kebab-case
- Always include console error capture in inspector steps
- Always include at least one screenshot assertion in ground truth
