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

  signContent(post) {
    const signs = Array.isArray(post.signs) ? post.signs : [];
    const root = this.popup("City sign post", signs.length + " inventory sign" + (signs.length === 1 ? "" : "s"));
    if (!this.available) add(root, "p", "Photo evidence is unavailable; image decisions are unknown.", "evidence-empty");
    if (!signs.length) add(root, "p", "No City sign details are available for this post.", "evidence-empty");
    for (const sign of signs) {
      add(root, "h4", sign.type || "Parking sign", "sign-heading");
      const photos = this.available ? linked(this.items, "sign_ids", sign.id) : [];
      if (photos.length) {
        for (const item of photos) this.photo(root, item);
        continue;
      }
      const card = add(root, "article", null, "evidence-card");
      const preview = add(card, "div", null, "record-sign");
      add(preview, "small", "City record preview · no photo");
      add(preview, "strong", sign.type || "Parking sign");
      add(preview, "span", sign.text || sign.code || "Wording unavailable");
      const facts = add(card, "dl", null, "evidence-facts");
      detail(facts, "Algorithm decision", this.available ? "Not evaluated from a photo" : "Unknown while evidence is unavailable");
      detail(facts, "Photo evidence", this.available ? "No crop linked to this sign" : "Unavailable");
      detail(facts, "City wording", sign.text || "Unavailable");
      detail(facts, "Sign code", sign.code);
      detail(facts, "Facing", sign.facing);
    }
    return root;
  }
}
