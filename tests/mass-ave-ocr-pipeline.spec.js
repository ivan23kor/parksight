const { test } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = '/home/ivan23kor/Code/parksight/evals/runs/mass-ave-ocr-pipeline';
const APP_URL = 'http://127.0.0.1:8080';

const PANO_POINTS = [
  { lat: 42.36103, lng: -71.0960 },
  { lat: 42.36103, lng: -71.0948 },
  { lat: 42.36103, lng: -71.0938 },
];

const report = {
  feature: 'mass-ave-ocr-pipeline',
  timestamp: new Date().toISOString(),
  steps_completed: 0,
  steps_total: 8,
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

async function clickMapAt(page, lat, lng) {
  // Close any open popups so they don't intercept the click
  await page.evaluate(() => {
    // eslint-disable-next-line no-undef
    map.closePopup();
  });

  const point = await page.evaluate(({ lat, lng }) => {
    // `map` is a `let` in the page's script scope, accessible here
    // eslint-disable-next-line no-undef
    if (typeof map === 'undefined') throw new Error('map variable not found');
    // eslint-disable-next-line no-undef
    const pt = map.latLngToContainerPoint(L.latLng(lat, lng));
    return { x: pt.x, y: pt.y };
  }, { lat, lng });

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

async function runDetectionAndWaitForOcr(page) {
  await page.click('#detectBtn');
  await page.waitForFunction(() => {
    // eslint-disable-next-line no-undef
    return currentDetections?.length > 0 &&
      currentDetections.every(d => d.ocrResult !== undefined);
  }, { timeout: 120000 });
}

async function extractOcrResults(page) {
  return page.evaluate(() => {
    // eslint-disable-next-line no-undef
    return currentDetections.map((det, i) => ({
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

  // Step 1: Load app and clear state
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.removeItem('parksight_latest_sign_map_data'));
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.screenshot({ path: path.join(OUTPUT_DIR, '01-app-loaded.png'), fullPage: true });
  report.screenshots.push('01-app-loaded.png');
  report.steps_completed = 1;
  writeReport();

  // Step 2: Navigate to pano point 1
  await clickMapAt(page, PANO_POINTS[0].lat, PANO_POINTS[0].lng);
  await waitForPanoLoad(page);

  await page.screenshot({ path: path.join(OUTPUT_DIR, '02-pano-point-1.png'), fullPage: true });
  report.screenshots.push('02-pano-point-1.png');
  report.steps_completed = 2;
  writeReport();

  // Step 3: Run detection + OCR on point 1
  await runDetectionAndWaitForOcr(page);

  const point1Results = await extractOcrResults(page);
  report.extracted_data['point1_ocr_results'] = point1Results;

  const signMapData1 = await page.evaluate(() => {
    const raw = localStorage.getItem('parksight_latest_sign_map_data');
    return raw ? JSON.parse(raw) : null;
  });
  report.extracted_data['point1_sign_map_data'] = signMapData1;

  await page.screenshot({ path: path.join(OUTPUT_DIR, '03-point1-detection-complete.png'), fullPage: true });
  report.screenshots.push('03-point1-detection-complete.png');
  report.steps_completed = 3;
  writeReport();

  // Step 4: Navigate to pano point 2
  await clickMapAt(page, PANO_POINTS[1].lat, PANO_POINTS[1].lng);
  await waitForPanoLoad(page);

  await page.screenshot({ path: path.join(OUTPUT_DIR, '04-pano-point-2.png'), fullPage: true });
  report.screenshots.push('04-pano-point-2.png');
  report.steps_completed = 4;
  writeReport();

  // Step 5: Run detection + OCR on point 2
  await runDetectionAndWaitForOcr(page);

  const point2Results = await extractOcrResults(page);
  report.extracted_data['point2_ocr_results'] = point2Results;

  await page.screenshot({ path: path.join(OUTPUT_DIR, '05-point2-detection-complete.png'), fullPage: true });
  report.screenshots.push('05-point2-detection-complete.png');
  report.steps_completed = 5;
  writeReport();

  // Step 6: Navigate to pano point 3
  await clickMapAt(page, PANO_POINTS[2].lat, PANO_POINTS[2].lng);
  await waitForPanoLoad(page);

  await page.screenshot({ path: path.join(OUTPUT_DIR, '06-pano-point-3.png'), fullPage: true });
  report.screenshots.push('06-pano-point-3.png');
  report.steps_completed = 6;
  writeReport();

  // Step 7: Run detection + OCR on point 3
  await runDetectionAndWaitForOcr(page);

  const point3Results = await extractOcrResults(page);
  report.extracted_data['point3_ocr_results'] = point3Results;

  await page.screenshot({ path: path.join(OUTPUT_DIR, '07-point3-detection-complete.png'), fullPage: true });
  report.screenshots.push('07-point3-detection-complete.png');
  report.steps_completed = 7;
  writeReport();

  // Step 8: Extract final accumulated state
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
    if (window.ruleCurvesLayer) {
      window.ruleCurvesLayer.eachLayer(layer => {
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

  await page.screenshot({ path: path.join(OUTPUT_DIR, '08-final-state.png'), fullPage: true });
  report.screenshots.push('08-final-state.png');
  report.steps_completed = 8;
  writeReport();
});
