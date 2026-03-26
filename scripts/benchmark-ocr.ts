#!/usr/bin/env bun
/**
 * Benchmark OCR performance: Direct backend vs CLI proxy
 */

import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";

async function prepareImage(imagePath: string): Promise<string> {
  const imageBuffer = fs.readFileSync(imagePath);
  const resizedBuffer = await sharp(imageBuffer)
    .resize(1280, 720, {
      fit: "inside",
      withoutEnlargement: true
    })
    .png({ quality: 80 })
    .toBuffer();
  const base64Image = resizedBuffer.toString("base64");
  const mime = imageBuffer[0] === 0x89 ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${base64Image}`;
}

async function callBackendDirect(imagePath: string): Promise<{ timeMs: number; result: any }> {
  const dataUrl = await prepareImage(imagePath);
  const base64Data = dataUrl.split(",")[1];

  const start = performance.now();
  const resp = await fetch("http://127.0.0.1:8000/ocr-sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_base64: base64Data })
  });
  const timeMs = performance.now() - start;

  const result = await resp.json();
  return { timeMs, result };
}

async function callViaProxy(imagePath: string): Promise<{ timeMs: number; result: any; content?: string }> {
  const dataUrl = await prepareImage(imagePath);

  const proxyApiKey = process.env.CLI_PROXY_API_KEY;
  if (!proxyApiKey) {
    throw new Error("CLI_PROXY_API_KEY not set");
  }

  const start = performance.now();
  const resp = await fetch("http://localhost:8317/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${proxyApiKey}`
    },
    body: JSON.stringify({
      model: "gemini-3-flash",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: dataUrl }
            },
            {
              type: "text",
              text: "Describe this image in one sentence."
            }
          ]
        }
      ],
      max_tokens: 100
    })
  });
  const timeMs = performance.now() - start;
  const result = await resp.json();
  const content = result.choices?.[0]?.message?.content || "";
  return { timeMs, result, content };
}

async function main() {
  const proxyApiKey = process.env.CLI_PROXY_API_KEY;

  if (!proxyApiKey) {
    console.error("CLI_PROXY_API_KEY not set");
    process.exit(1);
  }

  // Find image path
  let imagePath = process.argv[2];
  if (!imagePath) {
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
      console.error("No screenshots found");
      process.exit(1);
    }
    imagePath = files[0].path;
    console.log(`Using latest screenshot: ${files[0].name}`);
  } else {
    console.log(`Using provided image: ${path.basename(imagePath)}`);
  }

  console.log(`\nBenchmarking OCR: ${path.basename(imagePath)}`);
  console.log("=".repeat(50));

  // Warmup
  console.log("\nWarmup run...");
  try {
    await callBackendDirect(imagePath);
  } catch (e) {
    console.error("Warmup failed:", e);
  }

  const iterations = 3;
  const backendTimes: number[] = [];
  const proxyTimes: number[] = [];

  console.log(`\nRunning ${iterations} iterations each...\n`);

  for (let i = 0; i < iterations; i++) {
    console.log(`\n--- Iteration ${i + 1}/${iterations} ---`);

    // Backend direct
    process.stdout.write("Backend direct: ");
    try {
      const backendResult = await callBackendDirect(imagePath);
      backendTimes.push(backendResult.timeMs);
      console.log(`${backendResult.timeMs.toFixed(0)}ms`);
    } catch (e) {
      console.error("FAILED:", e);
    }

    // CLI proxy
    process.stdout.write("CLI proxy:    ");
    try {
      const proxyResult = await callViaProxy(imagePath);
      proxyTimes.push(proxyResult.timeMs);
      console.log(`${proxyResult.timeMs.toFixed(0)}ms`);
    } catch (e) {
      console.error("FAILED:", e);
    }
  }

  // Summary
  console.log("\n" + "=".repeat(50));
  console.log("\nRESULTS SUMMARY");
  console.log("=".repeat(50));

  if (backendTimes.length > 0) {
    const backendAvg = backendTimes.reduce((a, b) => a + b, 0) / backendTimes.length;
    console.log(`\nBackend API (/ocr-sign → CLI proxy):`);
    console.log(`  Times: ${backendTimes.map(t => t.toFixed(0) + "ms").join(", ")}`);
    console.log(`  Average: ${backendAvg.toFixed(0)}ms`);
  }

  if (proxyTimes.length > 0) {
    const proxyAvg = proxyTimes.reduce((a, b) => a + b, 0) / proxyTimes.length;
    console.log(`\nCLI proxy direct (localhost:8317):`);
    console.log(`  Times: ${proxyTimes.map(t => t.toFixed(0) + "ms").join(", ")}`);
    console.log(`  Average: ${proxyAvg.toFixed(0)}ms`);
  }

  if (backendTimes.length > 0 && proxyTimes.length > 0) {
    const backendAvg = backendTimes.reduce((a, b) => a + b, 0) / backendTimes.length;
    const proxyAvg = proxyTimes.reduce((a, b) => a + b, 0) / proxyTimes.length;
    const diff = proxyAvg - backendAvg;
    const pct = ((proxyAvg / backendAvg - 1) * 100).toFixed(1);
    console.log(`\nComparison: CLI proxy direct is ${Math.abs(diff).toFixed(0)}ms (${Math.abs(parseFloat(pct))}% ${diff < 0 ? "faster" : "slower"}) than backend`);
  }
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
