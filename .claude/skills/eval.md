---
name: eval
description: Run the eval loop for a Parksight feature. Spawns inspector agent (captures browser state), then evaluator agent (judges against ground truth). Usage /eval <feature-name>
user_invocable: true
---

# Eval Orchestrator

Run the full eval pipeline for a feature: inspector captures facts, evaluator judges them.

## Usage

```
/eval <feature-name>
```

Where `<feature-name>` matches a directory under `evals/specs/<feature-name>/` containing:
- `inspector.md` — steps for the inspector agent
- `ground-truth.md` — expectations for the evaluator agent

## Orchestration Steps

### Step 1: Validate spec exists

Read `evals/specs/<feature-name>/inspector.md` and `evals/specs/<feature-name>/ground-truth.md`. If either is missing, report error and stop.

### Step 2: Prepare run directory

Create `evals/runs/<feature-name>/` (clean it if it already exists).

### Step 3: Run Inspector

Spawn the `eval-inspector` agent with:
- **Prompt:** The full contents of `inspector.md` prefixed with:
  ```
  Feature: <feature-name>
  Output directory: evals/runs/<feature-name>/
  Project root: /home/ivan23kor/Code/parksight

  Execute the following inspector spec:
  ---
  <contents of inspector.md>
  ```
- **subagent_type:** Use the `eval-inspector` agent
- **Wait for completion**

### Step 4: Verify inspector output

Check that `evals/runs/<feature-name>/report.json` exists. If not, report inspector failure and stop.

Read and display a brief summary of the report:
- Steps completed vs total
- Screenshots taken
- Video filename (e.g., `test-rule-curve-intersections.webm`)
- Any errors encountered

Note: Videos are recorded automatically but not analyzed by the evaluator unless explicitly requested by a human.

### Step 5: Run Evaluator

Spawn the `eval-evaluator` agent with:
- **Prompt:** The full contents of `ground-truth.md` plus the full contents of `report.json`, prefixed with:
  ```
  Feature: <feature-name>
  Screenshots directory: /home/ivan23kor/Code/parksight/evals/runs/<feature-name>/

  Judge the following inspector report against the ground truth.

  ## Ground Truth
  ---
  <contents of ground-truth.md>
  ---

  ## Inspector Report
  ---
  <contents of report.json>
  ---
  ```
- **subagent_type:** Use the `eval-evaluator` agent
- **Wait for completion**

### Step 6: Display verdict

The evaluator's response IS the verdict. Display it to the user.

Extract the result line (PASS/FAIL + count) and display it prominently.

## Error Handling

- If inspector fails: show its error output, do not proceed to evaluator
- If evaluator fails: show its error output
- If spec files are missing: list available specs from `evals/specs/`

## Anti-Bias Verification

The orchestrator must verify structural separation:
- Inspector prompt must NOT contain any text from ground-truth.md
- Evaluator prompt must NOT contain any text from inspector.md
- Evaluator must NOT have Bash tool access (enforced by agent config)
