---
name: write-eval-spec
description: Interactive skill that takes a user story about a Parksight feature and produces structured inspector.md + ground-truth.md eval specs through Socratic questioning. Use when user wants to create an eval spec for a feature.
user_invocable: true
---

# Write Eval Spec

You are a spec writer for the Parksight eval system. The user will describe a feature in their own words — a user story, a bug description, or a feature request. Your job is to:

1. Understand their intent through targeted questions
2. Produce two files: `inspector.md` (steps only) and `ground-truth.md` (expectations only)

## Phase 1: Understand the Feature

Ask the user focused questions to fill gaps. You need to know:

### What to do (for inspector)
- Which URL/page to open?
- What data to load? (fixture files, localStorage, page.evaluate calls)
- What UI interactions to perform? (clicks, draws, selections)
- What to screenshot? (full page, zoomed area, specific element)
- What DOM/layer data to extract? (which layers, what properties)

### What to expect (for ground truth)
- What should be visible? (colors, shapes, positions)
- What should NOT be visible? (no overlaps, no extensions past boundaries)
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

**Key functions:**
- `renderSignMapData(data, allWays)` — renders all sign data on map
- `findIntersectionNodes(wayGeometry, allWays)` — finds cross-street intersections
- `findDistanceToNextSign(sign, dir, allSigns, wayGeo, intersections)` — distance-limited by intersections
- `buildRuleCurveLatLngs(sign, wayGeo, dir, ruleIndex, maxDist)` — builds curve geometry
- `projectSignToCurbLine(...)` — projects sign to fixed curb offset

**Test fixtures:**
- `tests/fixtures/vassar-street-mit-ways.json` — real OSM data for Vassar/Albany St area
- Vassar Street way ID 28631895, Albany Street way ID 442971020

**Data flow:**
- Detection results stored in `localStorage` key `parksight_latest_sign_map_data`
- Can be loaded via `renderSignMapData()` with fixture data in page.evaluate()

## Phase 2: Generate Specs

After understanding the feature, produce two files.

### `inspector.md` format
```markdown
# Inspector: <feature-name>

## Setup
- Start web server: `bun run serve` (from /home/ivan23kor/Code/parksight)
- Open: `http://127.0.0.1:8080/?api_key=$GOOGLE_MAPS_API_KEY`
- <any fixture loading or mocking setup>

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
