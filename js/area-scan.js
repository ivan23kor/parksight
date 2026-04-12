/**
 * Area Scan — freehand polygon → batch panorama detection pipeline.
 *
 * Flow: draw curve → close polygon → find street islands inside →
 * BFS linked-pano graph → gray dots → worker: YOLO + depth + projection →
 * green dots + rule curves + OCR.
 */

/* ── state ──────────────────────────────────────────────────────────── */

const areaScanState = {
  drawing: false,
  tracing: false,
  rawLatLngs: [],
  polygonFeature: null,
  previewLine: null,
  polygonShape: null,
  discoveredPanos: new Map(),
  detectionQueue: [],
  allWays: null,
  workerBusy: false,
  processed: 0,
  ocrDone: 0,
  cancelled: false,
  MAX_PANOS: 100,
};

const scanCache = new Map();

/* ── helpers ────────────────────────────────────────────────────────── */

function _normalize(b) { return ((b % 360) + 360) % 360; }

function _updateStatus(text) {
  const el = document.getElementById("scanAreaStatus");
  if (el) { el.textContent = text; el.style.display = text ? "block" : "none"; }
}

function _scanProgress() {
  const s = areaScanState;
  const total = s.discoveredPanos.size;
  if (!total) return;
  const allDone = s.processed >= total && !s.detectionQueue.length && !s.workerBusy;
  const parts = [`Detect ${s.processed}/${total}`, `OCR ${s.ocrDone}/${total}`];
  if (!allDone) parts.unshift(`Pano ${total}`);
  _updateStatus((allDone ? 'Done · ' : '') + parts.join(' · '));
}

function _scanBtn() { return document.getElementById("scanAreaBtn"); }

/* ── drawing ────────────────────────────────────────────────────────── */

function toggleAreaScanMode() {
  const state = areaScanState;
  if (state.drawing) {
    // Already in draw mode → cancel
    _exitDrawMode();
    if (state.discoveredPanos.size > 0 || state.workerBusy) {
      state.cancelled = true;
      _updateStatus(`Cancelled at ${state.processed}/${state.discoveredPanos.size}`);
    }
    return;
  }
  state.drawing = true;
  document.body.classList.add("area-scan-drawing");
  if (typeof map !== "undefined" && map) {
    map.dragging.disable();
    map.boxZoom?.disable();
    map.doubleClickZoom?.disable();
  }
  const btn = _scanBtn();
  if (btn) { btn.textContent = "Cancel scan"; btn.classList.add("active"); }
  _updateStatus("Draw an area on the map");
}

function _exitDrawMode() {
  const state = areaScanState;
  state.drawing = false;
  state.tracing = false;
  state.rawLatLngs = [];
  document.body.classList.remove("area-scan-drawing");
  if (typeof map !== "undefined" && map) {
    map.dragging.enable();
    map.boxZoom?.enable();
    map.doubleClickZoom?.enable();
  }
  const btn = _scanBtn();
  if (btn) { btn.textContent = "Scan area"; btn.classList.remove("active"); }
}

function _onMapMouseDown(e) {
  if (!areaScanState.drawing) return;
  const state = areaScanState;
  state.tracing = true;
  state.rawLatLngs = [e.latlng];
  if (state.previewLine) { state.previewLine.remove(); state.previewLine = null; }
  state.previewLine = L.polyline([], {
    color: "#3b82f6", weight: 3, opacity: 0.8,
  }).addTo(typeof scanAreaLayer !== "undefined" ? scanAreaLayer : map);
}

function _onMapMouseMove(e) {
  if (!areaScanState.tracing) return;
  areaScanState.rawLatLngs.push(e.latlng);
  areaScanState.previewLine.setLatLngs(areaScanState.rawLatLngs);
}

function _onMapMouseUp(e) {
  if (!areaScanState.tracing) return;
  const state = areaScanState;
  state.tracing = false;

  if (state.previewLine) { state.previewLine.remove(); state.previewLine = null; }

  // Need at least a triangle (4 points including closing point)
  if (state.rawLatLngs.length < 4) {
    _updateStatus("Too small — draw a larger area");
    return;
  }

  // Close the loop
  const closed = [...state.rawLatLngs, state.rawLatLngs[0]];
  const ring = closed.map(ll => [ll.lng, ll.lat]); // turf: [lng, lat]
  const polygonFeature = turf.polygon([ring]);

  // Validate non-zero area
  const area = turf.area(polygonFeature);
  if (area < 100) { // < 100 m²
    _updateStatus("Area too small");
    return;
  }

  state.polygonFeature = polygonFeature;

  // Draw filled polygon
  const latLngs = closed.map(c => [c.lat, c.lng]);
  state.polygonShape = L.polygon(latLngs, {
    color: "#3b82f6", weight: 2, fillColor: "#3b82f6", fillOpacity: 0.1,
  }).addTo(typeof scanAreaLayer !== "undefined" ? scanAreaLayer : map);

  _exitDrawMode();
  startAreaScan(polygonFeature);
}

/* ── street islands ─────────────────────────────────────────────────── */

function _waysIntersectPolygon(ways, polygonFeature) {
  const results = [];
  for (const way of ways) {
    const nodes = way.geometry || [];
    let inside = false;
    for (const node of nodes) {
      const pt = turf.point([node.lon ?? node.lng, node.lat]);
      if (turf.booleanPointInPolygon(pt, polygonFeature)) { inside = true; break; }
    }
    if (inside) results.push(way);
  }
  return results;
}

function _findStreetIslands(insideWays) {
  // Union-Find by coordinate key (1e-6 precision ≈ 0.1m)
  const parent = new Map();
  const coordKey = (lat, lon) => `${(lat ?? 0).toFixed(6)},${(lon ?? 0).toFixed(6)}`;

  function find(key) {
    if (!parent.has(key)) parent.set(key, key);
    if (parent.get(key) !== key) parent.set(key, find(parent.get(key)));
    return parent.get(key);
  }
  function union(a, b) { parent.set(find(a), find(b)); }

  // Build node-to-ways index and union all shared nodes
  const nodeToWays = new Map();
  for (const way of insideWays) {
    for (const n of way.geometry || []) {
      const k = coordKey(n.lat, n.lon ?? n.lng);
      if (!nodeToWays.has(k)) nodeToWays.set(k, []);
      nodeToWays.get(k).push(way);
    }
  }

  // Union consecutive nodes within each way
  for (const way of insideWays) {
    const nodes = way.geometry || [];
    for (let i = 1; i < nodes.length; i++) {
      union(coordKey(nodes[i - 1].lat, nodes[i - 1].lon ?? nodes[i - 1].lng),
            coordKey(nodes[i].lat, nodes[i].lon ?? nodes[i].lng));
    }
  }

  // Union ways that share any node
  for (const [, ways] of nodeToWays) {
    if (ways.length < 2) continue;
    const k0 = coordKey(ways[0].geometry?.[0]?.lat, ways[0].geometry?.[0]?.lon ?? ways[0].geometry?.[0]?.lng);
    for (let i = 1; i < ways.length; i++) {
      const ki = coordKey(ways[i].geometry?.[0]?.lat, ways[i].geometry?.[0]?.lon ?? ways[i].geometry?.[0]?.lng);
      union(k0, ki);
    }
  }

  // Group ways by root
  const groups = new Map();
  for (const way of insideWays) {
    const k = coordKey(way.geometry?.[0]?.lat, way.geometry?.[0]?.lon ?? way.geometry?.[0]?.lng);
    const root = find(k);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(way);
  }

  // Build islands with seed points inside polygon
  const islands = [];
  for (const [, ways] of groups) {
    let seed = null;
    for (const way of ways) {
      for (const n of way.geometry || []) {
        const pt = turf.point([n.lon ?? n.lng, n.lat]);
        if (turf.booleanPointInPolygon(pt, areaScanState.polygonFeature)) {
          seed = { lat: n.lat, lng: n.lon ?? n.lng };
          break;
        }
      }
      if (seed) break;
    }
    if (seed) islands.push({ ways, seedLatLng: seed });
  }
  return islands;
}

/* ── seed pano discovery ────────────────────────────────────────────── */

async function _discoverSeedPano(seedLatLng) {
  try {
    const request = {
      location: { lat: seedLatLng.lat, lng: seedLatLng.lng },
      radius: 100,
    };
    if (typeof google !== "undefined" && google?.maps?.StreetViewPreference?.NEAREST) {
      request.preference = google.maps.StreetViewPreference.NEAREST;
    }
    if (typeof google !== "undefined" && google?.maps?.StreetViewSource?.OUTDOOR) {
      request.source = google.maps.StreetViewSource.OUTDOOR;
    }
    const panoData = await resolveStreetViewPanorama(request, 10000);
    if (!panoData?.location?.pano) return null;
    const loc = panoData.location;
    return {
      panoId: loc.pano,
      lat: typeof loc.latLng?.lat === "function" ? loc.latLng.lat() : loc.latLng?.lat,
      lng: typeof loc.latLng?.lng === "function" ? loc.latLng.lng() : loc.latLng?.lng,
    };
  } catch (err) {
    console.warn("[area-scan] seed pano discovery failed:", err);
    return null;
  }
}

/* ── BFS linked-pano graph ──────────────────────────────────────────── */

async function _bfsPanosInPolygon(seedPanoId, polygonFeature) {
  const state = areaScanState;
  const visited = new Set();
  visited.add(seedPanoId);

  let frontier = [seedPanoId];

  // Emit seed itself
  const seedData = await resolveStreetViewPanorama({ pano: seedPanoId }, 10000);
  if (!seedData?.location?.latLng) return;
  const seedLoc = seedData.location;
  const seedLat = typeof seedLoc.latLng.lat === "function" ? seedLoc.latLng.lat() : seedLoc.latLng.lat;
  const seedLng = typeof seedLoc.latLng.lng === "function" ? seedLoc.latLng.lng() : seedLoc.latLng.lng;
  const seedPt = turf.point([seedLng, seedLat]);
  if (turf.booleanPointInPolygon(seedPt, polygonFeature)) {
    _emitPano(seedPanoId, seedLat, seedLng);
  }

  while (frontier.length > 0 && !state.cancelled && state.discoveredPanos.size < state.MAX_PANOS) {
    // Resolve links for all frontier panos
    const frontierResults = await Promise.allSettled(
      frontier.map(pid => resolveStreetViewPanorama({ pano: pid }, 10000))
    );

    const nextPanos = [];
    for (const result of frontierResults) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const links = result.value.links || [];
      for (const link of links) {
        if (!link?.pano || visited.has(link.pano)) continue;
        nextPanos.push(link.pano);
      }
    }

    if (nextPanos.length === 0) break;

    // Resolve positions for all candidates
    const resolved = await Promise.allSettled(
      nextPanos.map(async (pid) => {
        const data = await resolveStreetViewPanorama({ pano: pid }, 10000);
        if (!data?.location?.latLng) return null;
        const loc = data.location;
        const lat = typeof loc.latLng.lat === "function" ? loc.latLng.lat() : loc.latLng.lat;
        const lng = typeof loc.latLng.lng === "function" ? loc.latLng.lng() : loc.latLng.lng;
        return { panoId: pid, lat, lng };
      })
    );

    frontier = [];
    for (const result of resolved) {
      if (state.cancelled || state.discoveredPanos.size >= state.MAX_PANOS) break;
      if (result.status !== "fulfilled" || !result.value) continue;
      const { panoId, lat, lng } = result.value;
      if (visited.has(panoId)) continue;
      visited.add(panoId);

      const pt = turf.point([lng, lat]);
      if (!turf.booleanPointInPolygon(pt, polygonFeature)) continue;

      _emitPano(panoId, lat, lng);
      frontier.push(panoId);
    }
  }
}

function _emitPano(panoId, lat, lng) {
  const state = areaScanState;
  if (state.discoveredPanos.has(panoId) || state.discoveredPanos.size >= state.MAX_PANOS) return;

  const layer = typeof scanAreaLayer !== "undefined" ? scanAreaLayer : map;
  const marker = L.circleMarker([lat, lng], {
    radius: 5, color: "#9ca3af", fillColor: "#d1d5db", fillOpacity: 0.7, weight: 1,
  }).addTo(layer);

  state.discoveredPanos.set(panoId, { lat, lng, marker, status: "discovered" });
  state.detectionQueue.push(panoId);

  _scanProgress();

  // Kick detection worker
  _tickWorker();
}

/* ── orchestration ──────────────────────────────────────────────────── */

async function startAreaScan(polygonFeature) {
  const state = areaScanState;

  // Reset scan state (keep cache)
  state.discoveredPanos.clear();
  state.detectionQueue = [];
  state.allWays = null;
  state.workerBusy = false;
  state.processed = 0;
  state.ocrDone = 0;
  state.cancelled = false;
  state.polygonFeature = polygonFeature;

  _updateStatus("Finding streets\u2026");

  // Fetch streets for polygon bbox
  const bbox = turf.bbox(polygonFeature);
  const bounds = L.latLngBounds(
    [bbox[1], bbox[0]], // SW
    [bbox[3], bbox[2]], // NE
  );
  const allWays = await fetchStreets(bounds).catch(() => []);
  state.allWays = allWays;

  // Filter to ways inside polygon
  const insideWays = _waysIntersectPolygon(allWays, polygonFeature);
  if (insideWays.length === 0) {
    _updateStatus("No streets found in selected area");
    return;
  }

  // Cluster into islands
  const islands = _findStreetIslands(insideWays);
  console.log(`[area-scan] ${insideWays.length} ways → ${islands.length} islands`);

  _updateStatus(`Found ${islands.length} street island(s), scanning\u2026`);

  // BFS from each island seed
  for (const island of islands) {
    if (state.cancelled || state.discoveredPanos.size >= state.MAX_PANOS) break;

    const seed = await _discoverSeedPano(island.seedLatLng);
    if (!seed) {
      console.warn("[area-scan] no seed pano for island at", island.seedLatLng);
      continue;
    }

    await _bfsPanosInPolygon(seed.panoId, polygonFeature);
  }

  if (!state.cancelled) {
    if (state.discoveredPanos.size > 0) {
      _scanProgress();
    } else {
      _updateStatus("No panorama coverage found");
    }
  }
}

/* ── detection worker ───────────────────────────────────────────────── */

async function _tickWorker() {
  const state = areaScanState;
  if (state.workerBusy || state.detectionQueue.length === 0 || state.cancelled) return;

  state.workerBusy = true;
  try {
    while (state.detectionQueue.length > 0 && !state.cancelled) {
      const panoId = state.detectionQueue.shift();
      await _processPano(panoId);
      state.processed++;
      _scanProgress();
    }
  } finally {
    state.workerBusy = false;
    if (!state.cancelled && state.processed >= state.discoveredPanos.size && state.discoveredPanos.size > 0) {
      _scanProgress();
    }
  }
}

/* ── per-pano processing ────────────────────────────────────────────── */

async function _processPano(panoId) {
  const state = areaScanState;
  const entry = state.discoveredPanos.get(panoId);
  if (!entry) return;

  // Check cache
  if (scanCache.has(panoId)) {
    console.log(`[area-scan] cache hit: ${panoId}`);
    const cached = scanCache.get(panoId);
    // Re-render cached detection
    _promoteMarker(panoId, "cached");
    const store = appendSignMapDetection(cached.entry);
    const allWays = state.allWays;
    await renderSignMapData(store, allWays, new Set(), false);
    state.ocrDone++;
    return;
  }

  try {
    // 1. Metadata
    const session = await getSessionToken();
    const meta = await fetchStreetViewMetadata(panoId, session);
    const camLat = meta?.lat ?? entry.lat;
    const camLng = meta?.lng ?? entry.lng;

    // 2. Road context (direct call to avoid mutating currentDetectionContext)
    const allWays = state.allWays;
    const streetCtx = await fetchNearestStreetContext(camLat, camLng, allWays, 120, null);
    const streetBearing = Number.isFinite(streetCtx?.bearing) ? streetCtx.bearing : null;
    const oneway = streetCtx?.oneway ?? null;
    const streetName = streetCtx?.streetName ?? "Unknown street";

    // 3. Compute detection headings
    const b = Number.isFinite(streetBearing) ? streetBearing : (meta?.heading ?? 0);
    let headings;
    if (oneway) {
      headings = [_normalize(b + 45), _normalize(b - 45)];
    } else {
      // Two-way: right curb forward + right curb reverse
      headings = [_normalize(b + 45), _normalize(b - 135)];
    }

    // 4. Run detection for each heading
    const allDetections = [];
    const detectionResults = await Promise.allSettled(
      headings.map(h => runSinglePanoApiDetection(panoId, h, 0, 90, null))
    );

    for (const result of detectionResults) {
      if (result.status === "fulfilled" && result.value?.detections) {
        allDetections.push(...result.value.detections);
      }
    }

    // 5. Cluster
    const clustered = clusterAngularDetections(allDetections);

    if (clustered.length === 0) {
      _promoteMarker(panoId, "empty");
      state.ocrDone++;
      _scanProgress();
      return;
    }

    // 6. Promote marker to "processed"
    _promoteMarker(panoId, "processed");

    // 7. Set currentDetections for estimateAllSignLocations (reads global)
    const prevDetections = typeof currentDetections !== "undefined" ? currentDetections : [];
    currentDetections = clustered;

    // 8. Project signs
    const roadCtx = {
      streetBearing,
      oneway,
      side: "right",
      highway: streetCtx?.highway || null,
      lanes: streetCtx?.lanes || null,
      wayGeometry: streetCtx?.wayGeometry || null,
      segmentIndex: streetCtx?.segmentIndex ?? null,
      segmentStart: streetCtx?.segmentStart || null,
      segmentEnd: streetCtx?.segmentEnd || null,
      cameraHeading: headings[0],
    };
    const signLocations = estimateAllSignLocations(camLat, camLng, roadCtx);

    // 9. Run OCR on clustered detections
    await runOcrOnDetections(panoId, camLat, camLng, clustered);

    // Match OCR results to projected sign locations by heading
    for (const sign of signLocations) {
      let best = null, minDelta = Infinity;
      for (const det of clustered) {
        if (!det.ocrResult) continue;
        const d = Math.abs(signedAngleDeltaDegrees(det.heading, sign.heading));
        if (d < minDelta) { minDelta = d; best = det; }
      }
      if (best && (!sign.ocrResult?.is_parking_sign || best.ocrResult.is_parking_sign)) {
        sign.ocrResult = best.ocrResult;
      }
    }

    // 10. Build detection entry
    const detectionEntry = {
      savedAt: Date.now(),
      source: "area-scan",
      panoId,
      camera: { lat: camLat, lng: camLng },
      heading: headings[0],
      streetBearing,
      segmentStart: roadCtx.segmentStart,
      segmentEnd: roadCtx.segmentEnd,
      wayGeometry: roadCtx.wayGeometry,
      segmentIndex: roadCtx.segmentIndex,
      streetName,
      signs: signLocations,
    };

    // 11. Persist and render (with OCR data — rule curves will draw)
    const newSignUuids = new Set(signLocations.filter(s => s.uuid).map(s => s.uuid));
    const store = appendSignMapDetection(detectionEntry);
    await renderSignMapData(store, allWays, newSignUuids, false);
    state.ocrDone++;
    _scanProgress();

    // 12. Cache
    scanCache.set(panoId, { lat: camLat, lng: camLng, entry: detectionEntry });

    // Restore previous detections
    currentDetections = prevDetections;

  } catch (err) {
    console.error(`[area-scan] processPano ${panoId} failed:`, err);
    _promoteMarker(panoId, "error");
    state.ocrDone++;
  }
}

function _promoteMarker(panoId, status) {
  const state = areaScanState;
  const entry = state.discoveredPanos.get(panoId);
  if (!entry || !entry.marker) return;

  const colors = {
    processed: { color: "#3b82f6", fillColor: "#60a5fa", fillOpacity: 0.6 },
    cached:    { color: "#22c55e", fillColor: "#86efac", fillOpacity: 0.6 },
    empty:     { color: "#6b7280", fillColor: "#9ca3af", fillOpacity: 0.4 },
    error:     { color: "#ef4444", fillColor: "#fca5a5", fillOpacity: 0.5 },
  };
  const style = colors[status] || colors.processed;
  entry.marker.setStyle(style);
  entry.status = status;
}

/* ── init ───────────────────────────────────────────────────────────── */

function initAreaScan() {
  if (typeof map === "undefined" || !map) return;
  map.on("mousedown", _onMapMouseDown);
  map.on("mousemove", _onMapMouseMove);
  map.on("mouseup", _onMapMouseUp);
  console.log("[area-scan] initialized");
}
