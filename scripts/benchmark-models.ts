#!/usr/bin/env bun
/**
 * Benchmark OCR models on curated parking sign crops.
 *
 * Usage:
 *   bun run scripts/benchmark-models.ts [--crops-dir <path>] [--models gemini,sonnet,glm]
 *
 * Requires: GEMINI_API_KEY, ANTHROPIC_API_KEY, Z_AI_API_KEY
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import sharp from "sharp";

// --- Constants ---

const DEFAULT_CROPS_DIR = path.join(import.meta.dir, "..", "benchmark", "crops");
const RESULTS_BASE = path.join(import.meta.dir, "..", "benchmark", "results");

type ModelId = "gemini" | "sonnet" | "glm";

const ALL_MODELS: ModelId[] = ["gemini", "sonnet", "glm"];

const MODEL_LABELS: Record<ModelId, string> = {
  gemini: "gemini-3.1-flash-lite-preview",
  sonnet: "sonnet-4.6",
  glm: "glm-5.1",
};

// --- OCR Prompt (from backend/main.py) ---

const OCR_PROMPT = `You are a parking sign parser. You will receive a cropped image from a street-level panorama that a parking-sign detector flagged. Your job is to extract structured parking regulation data.

**CRITICAL: Respond with valid JSON only. No prose, no markdown headers, no explanations outside the JSON structure. Your entire response must be parseable by \`JSON.parse()\`.**

## Step 1 — Validate
A valid input is an image where **a single parking sign cluster is the primary subject**. A parking sign cluster is defined as one or more rectangular regulatory sign plates mounted on a single post, photographed close enough that the text on each plate is individually legible. The sign plates must convey parking/standing rules to drivers (permitted hours, time limits, payment requirements, no-parking restrictions, tow warnings, permit conditions).

If the image does not match this definition exactly, respond ONLY with:
\`\`\`
{"is_parking_sign": false, "rejection_reason": "<brief description of what is actually shown>"}
\`\`\`
Do not attempt extraction from any image that does not meet this definition.

## Step 2 — Extract rules
Every sign cluster is treated as a sequence of one or more rules. A cluster with a single plate is simply a sequence of length one. Extract each rule as a separate entry in the \`rules\` array, ordered top to bottom.

**Payment splitting rule:** If a single sign plate allows parking with a time limit but payment is required on some days and free on others, split that plate into two separate rule entries — one for the paid days and one for the free days — even if the time window and limit are identical. This is in addition to any other splits required by different time windows or stacked plates.

**Tow zones:** Tow enforcement is extracted separately from parking rules into the \`tow_zones\` array. Each tow zone entry captures the time window and direction in which towing is enforced. Do not mix tow zone entries into the \`rules\` array.

**Arrow direction per plate:** Each rule or tow_zone entry must use the arrow direction that appears on THAT SPECIFIC PLATE only. If a sign has multiple stacked plates with different arrows, do NOT apply one plate's arrow to another. If a plate has no visible arrow, set \`arrow_direction\` to \`null\` or \`"none"\`, not the arrow from a different plate.

Your entire response must conform exactly to this JSON structure:
\`\`\`
{
  "is_parking_sign": true,
  "confidence_readable": "high" | "medium" | "low",
  "rules": [
    {
      "category": "no_parking" | "parking_allowed" | "loading_zone" | "permit_required",
      "time_limit_minutes": <integer or null>,
      "days": ["mon","tue","wed","thu","fri","sat","sun"] or null,
      "time_start": "HH:MM" or null,
      "time_end": "HH:MM" or null,
      "payment_required": true | false | null,
      "permit_zone": "<zone identifier string or null>",
      "arrow_direction": "left" | "right" | "both" | "none" | null,
      "additional_text": "<any other text on this part of the sign or null>"
    }
  ],
  "tow_zones": [
    {
      "days": ["mon","tue","wed","thu","fri","sat","sun"] or null,
      "time_start": "HH:MM" or null,
      "time_end": "HH:MM" or null,
      "arrow_direction": "left" | "right" | "both" | "none" | null,
      "additional_text": "<any other text on this tow plate or null>"
    }
  ],
  "raw_text": "<all text you can read on the sign, top to bottom, separated by newlines>",
  "notes": "<anything ambiguous, partially occluded, or uncertain. null if nothing to note>"
}
\`\`\`

## Field guidance
- **\`category\`:** \`"parking_allowed"\` covers all cases where parking is permitted, whether free or paid, with or without a time limit. Use \`time_limit_minutes\` and \`payment_required\` to distinguish the specifics. All other categories describe restrictions or prohibitions.
- **\`payment_required\`:** \`true\` if a meter, pay station, or "PAY" instruction applies. \`false\` if parking is free during this window. \`null\` if not determinable from the sign.
- **\`days\`:** List only the days this specific rule applies to. \`"MON THRU FRI"\` → \`["mon","tue","wed","thu","fri"]\`. \`"EXCEPT SUNDAY"\` → all days except Sunday.
- **\`time_start\` / \`time_end\`:** 24-hour format. \`"7AM"\` → \`"07:00"\`, \`"6P"\` → \`"18:00"\`. Never infer times from phone numbers, stall numbers, zone codes, or any other reference information printed on the sign — put those in \`additional_text\` or \`notes\` instead.
- **\`arrow_direction\`:** Direction from the sign post that this rule applies to. **CRITICAL:** Only use the arrow that appears on the same plate as this rule. Do NOT borrow arrows from other plates. If the plate has no arrow symbol, use \`null\` or \`"none"\`.
- **\`confidence_readable\`:** Reflects the hardest-to-read rule on the sign. If any plate is partially occluded or at a steep angle, set to \`"low"\` and explain in \`"notes"\`.
- Do NOT hallucinate text. If you cannot read a word, write \`[illegible]\` in \`raw_text\` and note it.
- Do NOT add any text, commentary, or formatting outside the JSON object.`;

// --- Types ---

interface ModelResult {
  model_id: string;
  image_name: string;
  raw_response: string;
  parsed_json: any | null;
  latency_ms: number;
  timestamp: string;
  success: boolean;
  error: string | null;
}

interface ModelStats {
  total: number;
  successful: number;
  failed: number;
  valid_json: number;
  invalid_json: number;
  avg_latency_ms: number;
  min_latency_ms: number;
  max_latency_ms: number;
}

// --- JSON extraction ---

function tryParseJson(content: string): any | null {
  try { return JSON.parse(content); } catch {}
  const m = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  return null;
}

// --- Model callers ---

function callViaCli(
  imagePath: string,
  cliArgs: string,
  env?: Record<string, string>
): { content: string; latencyMs: number } {
  const absPath = path.resolve(imagePath);
  const prompt = `${OCR_PROMPT}\n\nAnalyze the parking sign image at: ${absPath}`;
  const start = performance.now();
  const stdout = execSync(
    `claude -p ${cliArgs} --bare --dangerously-skip-permissions --allowedTools "Read" --output-format json`,
    {
      input: prompt,
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    }
  );
  const latencyMs = Math.round(performance.now() - start);
  const data = JSON.parse(stdout);
  return { content: data.result, latencyMs };
}

function callSonnet(imagePath: string): { content: string; latencyMs: number } {
  return callViaCli(imagePath, `--model sonnet`, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
}

function callGlm(imagePath: string): { content: string; latencyMs: number } {
  return callViaCli(
    imagePath,
    `--model opus`,
    {
      ANTHROPIC_AUTH_TOKEN: process.env.Z_AI_API_KEY!,
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.1",
    }
  );
}

// --- Gemini ---

async function prepareImageBase64(imagePath: string): Promise<{ base64: string; mimeType: string }> {
  const imageBuffer = fs.readFileSync(imagePath);
  const resizedBuffer = await sharp(imageBuffer)
    .resize(1280, 720, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { base64: resizedBuffer.toString("base64"), mimeType: "image/jpeg" };
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;

async function callGemini(imagePath: string): Promise<{ content: string; latencyMs: number }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const { base64, mimeType } = await prepareImageBase64(imagePath);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
      console.error(`  Retry ${attempt}/${MAX_RETRIES} after ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
    const start = performance.now();
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_LABELS.gemini}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ inlineData: { mimeType, data: base64 } }, { text: OCR_PROMPT }] }]
        })
      }
    );
    const latencyMs = Math.round(performance.now() - start);
    if (resp.ok) {
      const data = await resp.json() as any;
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (!content) throw new Error(`Empty Gemini response: ${JSON.stringify(data)}`);
      return { content, latencyMs };
    }
    if (resp.status === 429 || resp.status >= 500) {
      lastError = new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      continue;
    }
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
  throw lastError!;
}

// --- Run one model on one image ---

async function runOne(modelId: ModelId, imagePath: string, imageName: string): Promise<ModelResult> {
  const timestamp = new Date().toISOString();
  try {
    let result: { content: string; latencyMs: number };

    if (modelId === "gemini") {
      result = await callGemini(imagePath);
    } else if (modelId === "sonnet") {
      result = callSonnet(imagePath);
    } else {
      result = callGlm(imagePath);
    }

    return {
      model_id: MODEL_LABELS[modelId],
      image_name: imageName,
      raw_response: result.content,
      parsed_json: tryParseJson(result.content),
      latency_ms: result.latencyMs,
      timestamp,
      success: true,
      error: null,
    };
  } catch (e: any) {
    return {
      model_id: MODEL_LABELS[modelId],
      image_name: imageName,
      raw_response: "",
      parsed_json: null,
      latency_ms: 0,
      timestamp,
      success: false,
      error: e.message || String(e),
    };
  }
}

// --- Stats ---

function computeStats(results: ModelResult[]): ModelStats {
  const successful = results.filter(r => r.success);
  const latencies = successful.map(r => r.latency_ms);
  const sorted = [...latencies].sort((a, b) => a - b);

  return {
    total: results.length,
    successful: successful.length,
    failed: results.length - successful.length,
    valid_json: results.filter(r => r.parsed_json !== null).length,
    invalid_json: results.filter(r => r.success && r.parsed_json === null).length,
    avg_latency_ms: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
    min_latency_ms: sorted.length ? sorted[0] : 0,
    max_latency_ms: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

// --- CLI args ---

function parseArgs(): { cropsDir: string; models: ModelId[] } {
  const args = process.argv.slice(2);
  let cropsDir = DEFAULT_CROPS_DIR;
  let models = ALL_MODELS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--crops-dir" && args[i + 1]) {
      cropsDir = path.resolve(args[++i]);
    } else if (args[i] === "--models" && args[i + 1]) {
      models = args[++i].split(",").map(m => m.trim()) as ModelId[];
      for (const m of models) {
        if (!ALL_MODELS.includes(m) && m !== "gemini") {
          console.error(`Unknown model: ${m}. Valid: ${ALL_MODELS.join(", ")}`);
          process.exit(1);
        }
      }
    }
  }
  return { cropsDir, models };
}

// --- Main ---

async function main() {
  const { cropsDir, models } = parseArgs();

  if (models.includes("gemini") && !process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY not set");
    process.exit(1);
  }
  if (models.includes("glm") && !process.env.Z_AI_API_KEY) {
    console.error("Z_AI_API_KEY not set");
    process.exit(1);
  }
  if (!fs.existsSync(cropsDir)) {
    console.error(`Crops directory not found: ${cropsDir}`);
    process.exit(1);
  }

  const images = fs.readdirSync(cropsDir)
    .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
    .sort();
  if (images.length === 0) {
    console.error(`No images in ${cropsDir}`);
    process.exit(1);
  }

  const runTs = new Date().toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "");
  const runDir = path.join(RESULTS_BASE, runTs);
  fs.mkdirSync(runDir, { recursive: true });

  console.error(`\nBenchmark run: ${runTs}`);
  console.error(`Images: ${images.length} from ${cropsDir}`);
  console.error(`Models: ${models.map(m => MODEL_LABELS[m]).join(", ")}\n`);

  const allResults: Record<string, ModelResult[]> = {};
  const totalStart = performance.now();

  for (const modelId of models) {
    const label = MODEL_LABELS[modelId];
    const modelDir = path.join(runDir, label);
    fs.mkdirSync(modelDir, { recursive: true });

    console.error(`[${models.indexOf(modelId) + 1}/${models.length}] ${label}`);
    const modelResults: ModelResult[] = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const imgPath = path.join(cropsDir, img);
      process.stderr.write(`  [${i + 1}/${images.length}] ${img} ... `);

      const result = await runOne(modelId, imgPath, img);
      modelResults.push(result);

      const baseName = img.replace(/\.[^.]+$/, "");
      fs.writeFileSync(
        path.join(modelDir, `${baseName}.json`),
        JSON.stringify(result, null, 2)
      );

      if (result.success) {
        const jsonStatus = result.parsed_json ? "valid JSON" : "invalid JSON";
        console.error(`${result.latency_ms}ms (${jsonStatus})`);
      } else {
        console.error(`FAILED: ${result.error}`);
      }
    }

    const stats = computeStats(modelResults);
    console.error(`  Summary: ${stats.successful}/${stats.total} OK, ${stats.valid_json} valid JSON, avg ${stats.avg_latency_ms}ms\n`);
    allResults[label] = modelResults;
  }

  const totalMs = Math.round(performance.now() - totalStart);

  const summary: Record<string, any> = {
    run_timestamp: runTs,
    crops_dir: cropsDir,
    image_count: images.length,
    models: models.map(m => MODEL_LABELS[m]),
    results: {},
    total_duration_ms: totalMs,
  };
  for (const [label, results] of Object.entries(allResults)) {
    summary.results[label] = computeStats(results);
  }
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));

  console.error(`Run complete in ${(totalMs / 1000).toFixed(1)}s`);
  console.log(path.join(runDir, "summary.json"));
}

main().catch(err => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
