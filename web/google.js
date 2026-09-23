import { PILOT } from "./config.js";
import { EvidenceViewer } from "./evidence.js";
import { PilotMap } from "./map.js";
import { PanoramaWalker } from "./walker.js";

const node = (id) => document.getElementById(id);

async function loadGoogle(key) {
  await new Promise((resolve, reject) => {
    const callback = "__parksightGoogleReady";
    const script = document.createElement("script");
    window[callback] = () => { delete window[callback]; resolve(); };
    script.onerror = () => reject(new Error("Google Maps could not load"));
    script.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) + "&callback=" + callback + "&loading=async";
    document.head.append(script);
  });
}

function showMapError(message) {
  let error = document.querySelector(".map-error");
  if (!error) {
    error = document.createElement("p");
    error.className = "map-error";
    error.setAttribute("role", "alert");
    node("googleMap").after(error);
  }
  error.textContent = message;
}

function showViewError(message) {
  const status = node("viewerStatus");
  status.textContent = message;
  status.hidden = false;
}

async function main() {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error("Map settings could not load");
  const config = await response.json();
  if (!config.google_maps_key) throw new Error("Google Maps is not configured");
  await loadGoogle(config.google_maps_key);

  const evidence = new EvidenceViewer();
  await evidence.load();
  const map = new google.maps.Map(node("googleMap"), {
    center: { lat: PILOT.tower[0], lng: PILOT.tower[1] },
    zoom: 17,
    mapTypeControl: true,
    mapTypeControlOptions: { position: google.maps.ControlPosition.LEFT_BOTTOM },
    streetViewControl: false,
    fullscreenControl: true,
  });
  const [[south, west], [north, east]] = PILOT.bounds;
  map.fitBounds({ west, south, east, north }, 36);

  const camera = new google.maps.Circle({
    map, radius: 4, strokeColor: "#fff", strokeWeight: 2,
    fillColor: "#348bd0", fillOpacity: 1, visible: false,
  });
  const walker = new PanoramaWalker((position) => {
    if (!position) return;
    camera.setCenter(position);
    camera.setVisible(true);
  });
  const walkerReady = walker.start();
  function openAt(at) {
    if (!at) return;
    walkerReady.catch(() => null)
      .then(() => walker.openLocation(at.lat, at.lng))
      .then(() => { node("viewerStatus").hidden = true; })
      .catch((error) => showViewError(error.message));
  }

  const pilotMap = new PilotMap(map, openAt, evidence);
  const citySignsToggle = node("showCitySigns");
  pilotMap.setSignsVisible(citySignsToggle.checked);
  citySignsToggle.addEventListener("change", (event) => pilotMap.setSignsVisible(event.target.checked));

  const results = await Promise.allSettled([pilotMap.loadZones(), pilotMap.loadSigns(), walkerReady]);
  if (results[0].status === "rejected") showMapError(results[0].reason.message);
  if (results[1].status === "rejected") {
    citySignsToggle.disabled = true;
    citySignsToggle.title = results[1].reason.message;
    showMapError(results[1].reason.message);
  }
  if (results[2].status === "rejected") showViewError(results[2].reason.message);
}

main().catch((error) => showMapError(error.message));
