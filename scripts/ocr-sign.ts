#!/usr/bin/env bun
/**
 * Parking Sign OCR Tool
 *
 * Extracts structured parking regulation data from sign images using
 * Z AI GLM-4.6v-flash vision model.
 *
 * Usage:
 *   bun run scripts/ocr-sign.ts <image_path>
 *   bun run scripts/ocr-sign.ts  # Uses latest screenshot
 *
 * Environment:
 *   Z_AI_API_KEY - API key for Z AI (required)
 *
 * Output:
 *   JSON object with parking rules extracted from the sign:
 *   {
 *     "is_parking_sign": true,
 *     "confidence_readable": "high",
 *     "rules": [
 *       {
 *         "action": "no_parking",
 *         "days": ["mon","tue","wed","thu","fri"],
 *         "time_start": "07:00",
 *         "time_end": "19:00",
 *         ...
 *       }
 *     ],
 *     "raw_text": "...",
 *     "notes": null
 *   }
 */

import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";

const OCR_PROMPT = `You are a parking sign parser. You will receive a cropped image from a street-level panorama that a parking-sign detector flagged. Your job is to extract structured parking regulation data.

**CRITICAL: Respond with valid JSON only. No prose, no markdown headers, no explanations outside the JSON structure. Your entire response must be parseable by \`JSON.parse()\`.**

## Step 1 — Validate
First, determine whether this image actually contains a parking or standing regulation sign. If it does NOT (e.g., it is a street name, speed limit, bus stop, construction sign, advertisement, utility pole, or any other non-parking object), respond ONLY with:
\`\`\`
{"is_parking_sign": false, "rejection_reason": "<brief description of what is actually shown>"}
\`\`\`
Do NOT attempt to extract parking rules from non-parking images.

## Step 2 — Extract rules
Every sign is treated as a sequence of one or more rules. A sign with a single restriction is simply a sequence of length one. Extract each rule as a separate entry in the \`rules\` array, ordered top to bottom.

**Payment splitting rule:** If a single sign plate allows parking with a time limit but payment is required on some days and free on others, split that plate into two separate rule entries — one for the paid days and one for the free days — even if the time window and limit are identical. This is in addition to any other splits required by different time windows or stacked plates.

Your entire response must conform exactly to this JSON structure:
\`\`\`
{
  "is_parking_sign": true,
  "confidence_readable": "high" | "medium" | "low",
  "rules": [
    {
      "action": "no_parking" | "no_standing" | "no_stopping" | "parking_allowed" | "tow_zone" | "loading_zone" | "permit_required" | "time_limit",
      "time_limit_minutes": <integer or null>,
      "days": ["mon","tue","wed","thu","fri","sat","sun"] or null,
      "time_start": "HH:MM" or null,
      "time_end": "HH:MM" or null,
      "payment_required": true | false | null,
      "permit_zone": "<zone identifier string or null>",
      "arrow_direction": "left" | "right" | "both" | "none" | null,
      "additional_text": "<any other text on this part of the sign>"
    }
  ],
  "raw_text": "<all text you can read on the sign, top to bottom, separated by newlines>",
  "notes": "<anything ambiguous, partially occluded, or uncertain. null if nothing to note>"
}
\`\`\`

## Field guidance
- **\`action\`:** Describes what the rule permits or prohibits during its window.
- **\`payment_required\`:** \`true\` if a meter, pay station, or "PAY" instruction applies. \`false\` if parking is free during this window. \`null\` if not determinable from the sign.
- **\`days\`:** List only the days this specific rule applies to. \`"MON THRU FRI"\` → \`["mon","tue","wed","thu","fri"]\`. \`"EXCEPT SUNDAY"\` → all days except Sunday.
- **\`time_start\` / \`time_end\`:** 24-hour format. \`"7AM"\` → \`"07:00"\`, \`"6P"\` → \`"18:00"\`.
- **\`arrow_direction\`:** Direction from the sign post that this rule applies to.
- **\`confidence_readable\`:** Reflects the hardest-to-read rule on the sign. If any plate is partially occluded or at a steep angle, set to \`"low"\` and explain in \`"notes"\`.
- Do NOT hallucinate text. If you cannot read a word, write \`[illegible]\` in \`raw_text\` and note it.
- Do NOT add any text, commentary, or formatting outside the JSON object.`;

async function main() {
  const apiKey = process.env.Z_AI_API_KEY;
  if (!apiKey) {
    console.error("Error: Z_AI_API_KEY environment variable not set");
    process.exit(1);
  }

  // Use provided path or find latest screenshot
  let screenshotPath = process.argv[2];
  if (screenshotPath) {
    if (!fs.existsSync(screenshotPath)) {
      console.error(`Error: File not found: ${screenshotPath}`);
      process.exit(1);
    }
    console.error(`Analyzing: ${path.basename(screenshotPath)}`);
  } else {
    const screenshotsDir = path.join(process.env.HOME!, "Pictures", "Screenshots");
    const files = fs.readdirSync(screenshotsDir)
      .filter(f => f.endsWith(".png") || f.endsWith(".jpg"))
      .map(f => ({
        name: f,
        path: path.join(screenshotsDir, f),
        mtime: fs.statSync(path.join(screenshotsDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) {
      console.error("Error: No screenshots found");
      process.exit(1);
    }
    screenshotPath = files[0].path;
    console.error(`Analyzing: ${files[0].name}`);
  }

  // Read image, resize to reduce size, and convert to base64 data URL
  const imageBuffer = fs.readFileSync(screenshotPath);
  const resizedBuffer = await sharp(imageBuffer)
    .resize(1280, 720, {
      fit: "inside",
      withoutEnlargement: true
    })
    .png({ quality: 80 })
    .toBuffer();
  const base64Image = resizedBuffer.toString("base64");
  const imageDataUrl = `data:image/png;base64,${base64Image}`;

  // Call z.ai Coding Plan API with GLM-4.6v-flash (vision model)
  const response = await fetch("https://api.z.ai/api/coding/paas/v4/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "glm-4.6v-flash",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: imageDataUrl
              }
            },
            {
              type: "text",
              text: OCR_PROMPT
            }
          ]
        }
      ],
      max_tokens: 4096
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`API Error: ${response.status}`);
    console.error(error);
    process.exit(1);
  }

  const data = await response.json() as any;

  if (data.choices && data.choices.length > 0) {
    console.log(data.choices[0].message.content);
  } else {
    console.error("No content in response");
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
