import { bearing } from "./walker.js";

const DATA_URL = "/data/calgary-tower-sign-evidence.json";

function add(parent, tag, value, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value != null) element.textContent = String(value);
  parent.append(element);
  return element;
}

function detail(parent, label, value) {
  if (value == null || value === "") return;
  add(parent, "dt", label);
  add(parent, "dd", value);
}

function readable(value) {
  return String(value).replaceAll("_", " ");
}

function localCrop(url) {
  if (typeof url !== "string" || !url) return null;
  try {
    const resolved = new URL(url, window.location.href);
    return resolved.origin === window.location.origin && /^https?:$/.test(resolved.protocol)
      ? resolved.href : null;
  } catch {
    return null;
  }
}

function linked(items, field, id) {
  if (typeof id !== "string" || !id) return [];
  return items.filter((item) => Array.isArray(item[field]) && item[field].some((linkedId) => linkedId === id));
}

export function rankByCenter(detections) {
  const distance = (detection) => {
    const box = Array.isArray(detection.box) ? detection.box : [];
    if (box.length !== 4 || !box.every((value) => typeof value === "number")) return 2;
    return Math.hypot((box[0] + box[2]) / 2 - 0.5, (box[1] + box[3]) / 2 - 0.5);
  };
  return [...detections].sort((a, b) => distance(a) - distance(b));
}

function imageDecision(reading) {
  if (!reading || typeof reading !== "object") return "Not evaluated from a photo";
  if (reading.is_parking_sign === false) return "Not a parking sign";
  const categories = Array.isArray(reading.rules)
    ? reading.rules.map((rule) => rule?.category).filter((value) => typeof value === "string" && value)
    : [];
  if (categories.length) return [...new Set(categories)].map(readable).join(", ");
  return reading.is_parking_sign === true ? "Parking sign; rule unresolved" : "Not evaluated from a photo";
}

export class EvidenceViewer {
  constructor() {
    this.items = [];
    this.available = false;
    this.streetViewCache = new Map();
    this.googleKeyValue = null;
  }

  async load() {
    try {
      const response = await fetch(DATA_URL);
      if (!response.ok) throw new Error("Sign evidence could not load");
      const data = await response.json();
      if (!Array.isArray(data.items)) throw new Error("Sign evidence is invalid");
      this.items = data.items
        .filter((item) => item && typeof item.id === "string" && item.id && localCrop(item.crop_url))
        .map((item) => ({ ...item, crop_url: localCrop(item.crop_url) }));
      this.available = true;
    } catch {
      this.items = [];
      this.available = false;
    }
  }

  popup(title, subtitle) {
    const root = document.createElement("div");
    root.className = "evidence-popup";
    add(root, "h3", title);
    if (subtitle) add(root, "p", subtitle, "evidence-subtitle");
    return root;
  }

  photo(root, item) {
    const card = add(root, "article", null, "evidence-card");
    const link = add(card, "a", null, "crop-link");
    link.href = item.crop_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", "Open reviewed sign crop at full size");
    const crop = add(link, "img");
    crop.src = item.crop_url;
    crop.alt = "Reviewed sign crop from an independent street photo";
    const facts = add(card, "dl", null, "evidence-facts");
    detail(facts, "Algorithm decision", imageDecision(item.reading));
    detail(facts, "Visible text", item.reading?.raw_text || "Unreadable");
    detail(facts, "Confidence", item.reading?.confidence);
    detail(facts, "Reader", item.reading?.model);
    detail(facts, "Photo source", item.source_label);
    detail(facts, "Captured", item.captured_at);
    if (Array.isArray(item.reading?.rules)) {
      item.reading.rules.forEach((rule, index) => {
        if (!rule || typeof rule !== "object") return;
        detail(facts, "Rule " + (index + 1), rule.category ? readable(rule.category) : "Unclassified");
        detail(facts, "Applies", rule.description);
        detail(facts, "Arrow", rule.arrow_direction && readable(rule.arrow_direction));
        detail(facts, "Max stay", rule.max_minutes == null ? null : rule.max_minutes + " min");
      });
    }
  }

  zoneContent(zone) {
    const root = this.popup(zone.label || "Curb zone", zone.street);
    const facts = add(root, "dl", null, "evidence-facts");
    detail(facts, "Map decision", zone.category ? readable(zone.category) : zone.label);
    detail(facts, "Basis", "City curb inventory");
    detail(facts, "Max stay", zone.max_stay_minutes == null ? null : zone.max_stay_minutes + " min");
    detail(facts, "Enforced", zone.enforceable_time);
    if (zone.parking_restrict_time && zone.parking_restrict_time !== "none") {
      detail(facts, "Restrictions", zone.parking_restrict_time);
    }
    const photos = this.available ? linked(this.items, "decision_zone_ids", zone.id) : [];
    if (!this.available) {
      detail(facts, "Photo evidence", "Unavailable");
      detail(facts, "Algorithm decision", "Unknown while evidence is unavailable");
    } else if (!photos.length) {
      detail(facts, "Photo evidence", "No crop contributed to this curb color");
      detail(facts, "Algorithm decision", "Not evaluated from a photo");
    } else {
      detail(facts, "Photo evidence", photos.length + " reviewed sign crop" + (photos.length === 1 ? "" : "s") + " linked to this curb");
      add(root, "p", "Sign crops used for this curb decision", "evidence-label");
      for (const item of photos) this.photo(root, item);
    }
    return root;
  }

  async postJson(url, body) {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error("The photo service could not be reached.");
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.detail || "That photo could not be analyzed.");
    }
    return response.json();
  }

  detectionCard(results, detection, autoParse) {
    const card = add(results, "article", null, "evidence-card");
    const frame = add(card, "div", null, "crop-frame");
    const crop = add(frame, "img");
    crop.src = "data:image/jpeg;base64," + detection.crop_base64;
    crop.alt = "Detected sign crop from the uploaded photo";
    const box = Array.isArray(detection.box) ? detection.box : [];
    if (box.length === 4 && box.every((value) => typeof value === "number")) {
      const outline = add(frame, "div", null, "crop-box");
      outline.style.left = box[0] * 100 + "%";
      outline.style.top = box[1] * 100 + "%";
      outline.style.width = Math.max(0, box[2] - box[0]) * 100 + "%";
      outline.style.height = Math.max(0, box[3] - box[1]) * 100 + "%";
    }
    if (typeof detection.confidence === "number") {
      add(frame, "span", Math.round(detection.confidence * 100) + "%", "crop-confidence");
    }
    const reading = add(card, "div", null, "check-reading");
    const runParse = async () => {
      reading.replaceChildren();
      const status = add(reading, "p", "Reading sign…", "check-status");
      try {
        const parsed = await this.postJson("/api/read-sign", { image_base64: detection.crop_base64 });
        status.remove();
        add(reading, "pre", JSON.stringify(parsed, null, 2), "reading-json");
      } catch (error) {
        status.textContent = error.message;
      }
    };
    if (autoParse) {
      runParse();
    } else {
      const button = add(reading, "button", "Parse sign text", "parse-button");
      button.type = "button";
      button.addEventListener("click", () => runParse());
    }
  }

  async googleKey() {
    if (this.googleKeyValue) return this.googleKeyValue;
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("Map settings could not load");
    const config = await response.json();
    if (!config.google_maps_key) throw new Error("Google Maps is not configured");
    this.googleKeyValue = config.google_maps_key;
    return this.googleKeyValue;
  }

  async streetViewAim(lat, lng) {
    const key = await this.googleKey();
    const pano = await new Promise((resolve, reject) => {
      new google.maps.StreetViewService().getPanorama({
        location: { lat, lng },
        radius: 90,
        sources: [google.maps.StreetViewSource.OUTDOOR],
        preference: google.maps.StreetViewPreference.NEAREST,
      }, (data, status) => {
        if (status === google.maps.StreetViewStatus.OK && data?.location?.pano) resolve(data);
        else reject(new Error("No Street View near this sign."));
      });
    });
    return {
      key,
      pano: pano.location.pano,
      heading: Math.round(bearing(pano.location.latLng, { lat, lng })),
    };
  }

  async streetViewFrame(aim, offset) {
    const url = "https://maps.googleapis.com/maps/api/streetview?size=640x480&fov=60&pitch=10&pano="
      + encodeURIComponent(aim.pano) + "&heading=" + (aim.heading + offset) + "&key=" + encodeURIComponent(aim.key);
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.crossOrigin = "anonymous";
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("The Street View image could not load."));
      element.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d").drawImage(image, 0, 0);
    try {
      return canvas.toDataURL("image/jpeg", 0.92).split(",", 2)[1] || "";
    } catch {
      throw new Error("The Street View image cannot be used here.");
    }
  }

  async streetViewFan(post, onProgress) {
    const aim = await this.streetViewAim(post.lat, post.lng);
    let loaded = false;
    for (const offset of [0, -22, 22]) {
      if (offset !== 0) onProgress?.("Checking nearby angles…");
      let image_base64 = "";
      try {
        image_base64 = await this.streetViewFrame(aim, offset);
        loaded = true;
      } catch {
        continue;
      }
      const payload = await this.postJson("/api/detect-photo", { image_base64 });
      if (Array.isArray(payload.detections) && payload.detections.length) return payload;
    }
    if (!loaded) throw new Error("Street View images could not load.");
    return { detections: [] };
  }

  async runStreetViewCheck(results, post) {
    results.replaceChildren();
    const status = add(results, "p", "Analyzing Street View…", "check-status");
    const cacheKey = post.postId || post.lat + "," + post.lng;
    if (!this.streetViewCache.has(cacheKey)) {
      this.streetViewCache.set(cacheKey, this.streetViewFan(post, (message) => {
        status.textContent = message;
      }));
    }
    let found = [];
    try {
      const payload = await this.streetViewCache.get(cacheKey);
      if (Array.isArray(payload.detections)) found = rankByCenter(payload.detections);
    } catch (error) {
      this.streetViewCache.delete(cacheKey);
      status.textContent = error.message;
      return;
    }
    add(results, "p", "Imagery © Google · verification only, never stored or published.", "check-hint");
    if (!found.length) {
      status.textContent = "No parking signs found in this Street View image.";
      return;
    }
    status.remove();
    found.forEach((detection, index) => this.detectionCard(results, detection, index === 0));
  }

  streetViewCheck(root, post, signs) {
    for (const sign of signs) add(root, "h4", sign.type || "Parking sign", "sign-heading");
    const wrap = add(root, "div", null, "photo-check");
    add(wrap, "p", "City record · no reviewed photo", "check-city");
    const results = add(wrap, "div", null, "check-results");
    this.runStreetViewCheck(results, post);
  }

  signContent(post) {
    const signs = Array.isArray(post.signs) ? post.signs : [];
    const root = this.popup("City sign post", signs.length + " inventory sign" + (signs.length === 1 ? "" : "s"));
    if (!this.available) add(root, "p", "Photo evidence is unavailable; image decisions are unknown.", "evidence-empty");
    if (!signs.length) {
      add(root, "p", "No City sign details are available for this post.", "evidence-empty");
      return root;
    }
    const unlinked = [];
    for (const sign of signs) {
      const photos = this.available ? linked(this.items, "sign_ids", sign.id) : [];
      if (!photos.length) {
        unlinked.push(sign);
        continue;
      }
      add(root, "h4", sign.type || "Parking sign", "sign-heading");
      for (const item of photos) this.photo(root, item);
    }
    if (unlinked.length) this.streetViewCheck(root, post, unlinked);
    return root;
  }
}
