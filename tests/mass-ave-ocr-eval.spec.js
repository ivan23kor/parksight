const { test } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = '/home/ivan23kor/Code/parksight';
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'evals/runs/mass-ave-ocr-pipeline');
const FIXTURE_PATH = path.join(PROJECT_ROOT, 'evals/specs/mass-ave-ocr-pipeline/capture-points.json');
const APP_URL = 'http://127.0.0.1:8080';
const EVAL_CAPTURE_KEY = 'parksight_eval_capture_points';

function loadCapturePoints() {
  // First try fixture file
  if (fs.existsSync(FIXTURE_PATH)) {
    const points = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
    if (Array.isArray(points) && points.length > 0) {
      return points;
    }
  }
  throw new Error(`Capture points not found.\nMark points in app: press M to mark, then Shift+M to save automatically.`);
}

async function loadCapturePointsFromAppStorage(page) {
  return page.evaluate((key) => {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : null;
  }, EVAL_CAPTURE_KEY);
}

function saveCapturePointsFixture(points) {
  try {
    const dir = path.dirname(FIXTURE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(FIXTURE_PATH, JSON.stringify(points, null, 2));
    console.log(`[eval-capture] Saved fixture: ${FIXTURE_PATH}`);
  } catch (err) {
    console.warn(`[eval-capture] Failed to save fixture: ${err.message}`);
  }
}

const report = {
  feature: 'mass-ave-ocr-pipeline',
  timestamp: new Date().toISOString(),
  steps_completed: 0,
  steps_total: 0,
  screenshots: [],
  video: null,
  extracted_data: {},
  console_logs: [],
  console_errors: [],
  errors: [],
};

function writeReport() {
  fs.writeFileSync(path.join(OUTPUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
}

function screenshot(name) {
  report.screenshots.push(name);
  return path.join(OUTPUT_DIR, name);
}

async function clickMapAt(page, lat, lng) {
  // Close any open popups so they don't intercept the click
  await page.evaluate(() => {
    // eslint-disable-next-line no-undef
    map.closePopup();
  });

  const point = await page.evaluate(({ lat, lng }) => {
    // eslint-disable-next-line no-undef
    if (typeof map === 'undefined') return null;
    // eslint-disable-next-line no-undef
    const pt = map.latLngToContainerPoint(L.latLng(lat, lng));
    return { x: pt.x, y: pt.y };
  }, { lat, lng });
  if (!point) throw new Error('map variable not accessible in page context');
  const mapEl = await page.$('#map');
  const box = await mapEl.boundingBox();
  await page.mouse.click(box.x + point.x, box.y + point.y);
}

async function waitForPanoLoad(page) {
  await page.waitForFunction(() => {
    const status = document.querySelector('#detectionStatus')?.textContent || '';
    // Pano is loaded when status is not empty and not a detection result
    return status.length > 0 && !status.includes('Found') && !status.includes('OCR');
  }, { timeout: 60000 });
}

async function setHeading(page, heading) {
  await page.evaluate((h) => {
    // eslint-disable-next-line no-undef
    if (!detectionPanorama) {
      console.log('[eval-test] detectionPanorama not available');
      return;
    }
    // eslint-disable-next-line no-undef
    const pov = detectionPanorama.getPov();
    pov.heading = h;
    // eslint-disable-next-line no-undef
    detectionPanorama.setPov(pov);
    console.log(`[eval-test] Set heading to ${h}°`);
  }, heading);
  // Let the panorama re-render at new heading
  await page.waitForTimeout(800);
}

async function runDetectionAndWaitForOcr(page) {
  await page.click('#detectBtn');
  await page.waitForFunction(() => {
    // eslint-disable-next-line no-undef
    const dets = currentDetections;
    if (!dets || dets.length === 0) {
      const status = document.querySelector('#detectionStatus')?.textContent || '';
      return status.includes('No parking signs');
    }
    return dets.every(d => d.ocrResult !== undefined);
  }, { timeout: 180000 }); // 3 min for detection + OCR
}

async function extractOcrResults(page) {
  return page.evaluate(() => {
    // eslint-disable-next-line no-undef
    return (currentDetections || []).map((det, i) => ({
      index: i,
      heading: det.heading,
      pitch: det.pitch,
      confidence: det.confidence,
      ocrResult: det.ocrResult ? {
        is_parking_sign: det.ocrResult.is_parking_sign,
        confidence_readable: det.ocrResult.confidence_readable,
        rules: det.ocrResult.rules,
        tow_zones: det.ocrResult.tow_zones,
        raw_text: det.ocrResult.raw_text,
        rejection_reason: det.ocrResult.rejection_reason,
      } : null,
    }));
  });
}

test('full OCR pipeline inspection', async ({ page }) => {
  let capturePoints = null;

  page.on('console', msg => {
    const entry = `[${msg.type()}] ${msg.text()}`;
    if (msg.type() === 'error' || msg.type() === 'warning') {
      report.console_errors.push(entry);
    } else {
      report.console_logs.push(entry);
    }
  });
  page.on('pageerror', err => {
    report.console_errors.push(`[pageerror] ${err.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      report.console_errors.push(`[network_error] ${response.status()} ${response.url()}`);
    }
  });

  // Step 1: Load app
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

  // Try to load capture points from app storage (set by Shift+M)
  capturePoints = await loadCapturePointsFromAppStorage(page);
  // Fall back to fixture file if not in storage
  if (!capturePoints || capturePoints.length === 0) {
    capturePoints = loadCapturePoints();
  }
  // Save to fixture for next run
  saveCapturePointsFixture(capturePoints);

  // 1 step for app load + 2 steps per point (navigate+detect) + 1 final
  report.steps_total = 1 + capturePoints.length * 2 + 1;

  await page.evaluate(() => localStorage.removeItem('parksight_latest_sign_map_data'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: screenshot('01-app-loaded.png'), fullPage: true });
  report.steps_completed = 1;
  writeReport();

  // Steps 2..N: For each capture point, navigate + set heading + detect
  let stepNum = 1;
  for (let i = 0; i < capturePoints.length; i++) {
    const pt = capturePoints[i];
    const pointNum = i + 1;

    // Navigate to point
    stepNum++;
    console.log(`[eval-test] === Point ${pointNum}: (${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}) @ ${pt.heading}° ===`);
    if (pt.panoId) {
        console.log(`[eval-test] Pano ID ${pt.panoId} provided, loading directly...`);
        await page.evaluate((id) => {
            // eslint-disable-next-line no-undef
            currentDetectionContext = { panoId: id, heading: 0, pointIndex: null, streetName: "Evaluated Location" };
            // eslint-disable-next-line no-undef
            initPanoramaForContext();
        }, pt.panoId);
    } else {
        await clickMapAt(page, pt.lat, pt.lng);
        console.log(`[eval-test] Clicked map, waiting for pano load...`);
    }
    try {
      await waitForPanoLoad(page);
    } catch (err) {
      const status = await page.evaluate(() => document.querySelector('#detectionStatus')?.textContent || '');
      console.error(`[eval-test] Pano load failed or timed out. Status: "${status}"`);
      await page.screenshot({ path: screenshot(`error-point-${pointNum}-pano-load.png`), fullPage: true });
      throw err;
    }
    console.log(`[eval-test] Pano loaded, setting heading...`);
    if (pt.heading !== undefined) {
      await setHeading(page, pt.heading);
    }
    console.log(`[eval-test] Taking screenshot...`);
    const navScreenshot = `${String(stepNum).padStart(2, '0')}-pano-point-${pointNum}.png`;
    await page.screenshot({ path: screenshot(navScreenshot), fullPage: true });
    console.log(`[eval-test] Screenshot saved: ${navScreenshot}`);
    report.steps_completed = stepNum;
    writeReport();

    // Run detection + OCR
    stepNum++;
    console.log(`[eval-test] Running detection...`);
    await runDetectionAndWaitForOcr(page);
    console.log(`[eval-test] Detection complete, extracting OCR results...`);
    const results = await extractOcrResults(page);
    report.extracted_data[`point${pointNum}_ocr_results`] = results;
    report.extracted_data[`point${pointNum}_capture`] = pt;
    console.log(`[eval-test] Found ${results.length} detections`);

    const detScreenshot = `${String(stepNum).padStart(2, '0')}-point${pointNum}-detection-complete.png`;
    console.log(`[eval-test] Taking detection screenshot...`);
    await page.screenshot({ path: screenshot(detScreenshot), fullPage: true });
    console.log(`[eval-test] Screenshot saved: ${detScreenshot}`);
    report.steps_completed = stepNum;
    writeReport();
  }

  // Final step: Extract accumulated state
  stepNum++;
  console.log(`[eval-test] === Final state extraction ===`);
  const finalSignMapData = await page.evaluate(() => {
    const raw = localStorage.getItem('parksight_latest_sign_map_data');
    const data = raw ? JSON.parse(raw) : null;
    return {
      savedAt: data?.savedAt,
      source: data?.source,
      detectionCount: data?.detections?.length,
      detections: data?.detections?.map(d => ({
        panoId: d.panoId,
        cameraLat: d.camera?.lat,
        cameraLng: d.camera?.lon,
        signCount: d.signs?.length,
        signs: d.signs?.map(s => ({
          lat: s.lat,
          lon: s.lon,
          heading: s.heading,
          distance: s.distance,
          ocrResult: s.ocrResult ? {
            is_parking_sign: s.ocrResult.is_parking_sign,
            rules: s.ocrResult.rules?.map(r => ({
              category: r.category,
              arrow_direction: r.arrow_direction,
              days: r.days,
              time_start: r.time_start,
              time_end: r.time_end,
              time_limit_minutes: r.time_limit_minutes,
            })),
            tow_zones: s.ocrResult.tow_zones,
            raw_text: s.ocrResult.raw_text,
          } : null,
        })),
      })),
    };
  });
  report.extracted_data['final_sign_map_data'] = finalSignMapData;

  const ruleCurveData = await page.evaluate(() => {
    const curves = [];
    // eslint-disable-next-line no-undef
    if (typeof ruleCurvesLayer !== 'undefined') {
      // eslint-disable-next-line no-undef
      ruleCurvesLayer.eachLayer(layer => {
        if (layer.getLatLngs) {
          curves.push({
            latLngs: layer.getLatLngs().map(ll => [ll.lat, ll.lng]),
            color: layer.options?.color,
            dashArray: layer.options?.dashArray,
            weight: layer.options?.weight,
          });
        }
      });
    }
    return { curveCount: curves.length, curves };
  });
  report.extracted_data['rule_curve_data'] = ruleCurveData;

  const finalScreenshot = `${String(stepNum).padStart(2, '0')}-final-state.png`;
  await page.screenshot({ path: screenshot(finalScreenshot), fullPage: true });
  report.steps_completed = stepNum;
  writeReport();
});
