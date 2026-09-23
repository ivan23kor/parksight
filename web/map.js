import { COLORS } from "./config.js";

function lineMidpoint(geometry) {
  const points = geometry.getArray();
  if (!points.length) return null;
  if (points.length === 1) return { lat: points[0].lat(), lng: points[0].lng() };
  const longitudeScale = Math.cos(points[0].lat() * Math.PI / 180);
  const lengths = [];
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    const north = points[index].lat() - points[index - 1].lat();
    const east = (points[index].lng() - points[index - 1].lng()) * longitudeScale;
    const length = Math.hypot(north, east);
    lengths.push(length);
    total += length;
  }
  let remaining = total / 2;
  for (let index = 1; index < points.length; index++) {
    if (remaining > lengths[index - 1]) {
      remaining -= lengths[index - 1];
      continue;
    }
    const share = lengths[index - 1] ? remaining / lengths[index - 1] : 0;
    return {
      lat: points[index - 1].lat() + share * (points[index].lat() - points[index - 1].lat()),
      lng: points[index - 1].lng() + share * (points[index].lng() - points[index - 1].lng()),
    };
  }
  return { lat: points.at(-1).lat(), lng: points.at(-1).lng() };
}

export class PilotMap {
  constructor(map, onLocation, evidence) {
    this.map = map;
    this.onLocation = onLocation;
    this.evidence = evidence;
    this.infoWindow = new google.maps.InfoWindow({ maxWidth: 340 });
    this.signMarkers = [];
    this.signsVisible = false;
    this.map.addListener("click", (event) => {
      this.clearZone();
      this.infoWindow.close();
      this.activeSignMarker = null;
      this.onLocation?.({ lat: event.latLng.lat(), lng: event.latLng.lng() });
    });
    this.infoWindow.addListener("closeclick", () => {
      this.clearZone();
      this.activeSignMarker = null;
    });
  }

  clearZone() {
    if (!this.selectedZone) return;
    this.map.data.revertStyle(this.selectedZone);
    this.selectedZone = null;
  }

  async loadZones() {
    const response = await fetch("/data/calgary-tower-curb-overlay.geojson");
    if (!response.ok) throw new Error("City curb overlay could not load");
    const data = await response.json();
    if (!Array.isArray(data.features) || !data.features.length) throw new Error("No City curb zones were found");
    this.map.data.addGeoJson(data);
    this.map.data.setStyle((feature) => ({
      strokeColor: feature.getProperty("color") || COLORS.other,
      strokeWeight: 8,
      strokeOpacity: .92,
    }));
    this.map.data.addListener("click", (event) => {
      event.domEvent?.stopPropagation();
      this.selectZone(event.feature, event.latLng);
    });
    this.map.data.addListener("mouseover", (event) => this.map.data.overrideStyle(event.feature, { strokeWeight: 12 }));
    this.map.data.addListener("mouseout", (event) => {
      if (event.feature !== this.selectedZone) this.map.data.revertStyle(event.feature);
    });
    return data;
  }

  selectZone(feature, clickedAt) {
    if (!feature) return;
    this.clearZone();
    this.selectedZone = feature;
    this.map.data.overrideStyle(feature, { strokeWeight: 13, strokeOpacity: 1 });
    const properties = {};
    feature.forEachProperty((value, key) => { properties[key] = value; });
    const at = clickedAt
      ? { lat: clickedAt.lat(), lng: clickedAt.lng() }
      : lineMidpoint(feature.getGeometry());
    if (!at) return;
    this.activeSignMarker = null;
    this.infoWindow.close();
    this.infoWindow.setContent(this.evidence.zoneContent(properties));
    this.infoWindow.setPosition(at);
    this.infoWindow.open({ map: this.map });
    this.onLocation?.(at);
  }

  async loadSigns() {
    const response = await fetch("/data/calgary-tower-signs.geojson");
    if (!response.ok) throw new Error("City sign inventory could not load");
    const data = await response.json();
    if (!Array.isArray(data.features) || !data.features.length) throw new Error("No City parking signs were found");
    for (const feature of data.features) {
      const [lng, lat] = feature.geometry.coordinates;
      const signs = feature.properties.signs;
      const marker = new google.maps.Marker({
        map: this.signsVisible ? this.map : null,
        position: { lat, lng },
        title: signs.length + " City parking sign" + (signs.length === 1 ? "" : "s") + " at this post",
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: "#8a4675", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2 },
      });
      marker.addListener("click", (event) => {
        event.domEvent?.stopPropagation();
        this.clearZone();
        this.activeSignMarker = marker;
        this.infoWindow.close();
        this.infoWindow.setContent(this.evidence.signContent({
          postId: feature.properties.post_id, signs, lat, lng,
        }));
        this.infoWindow.open({ map: this.map, anchor: marker });
        this.onLocation?.({ lat, lng });
      });
      this.signMarkers.push(marker);
    }
    return data;
  }

  setSignsVisible(visible) {
    this.signsVisible = Boolean(visible);
    for (const marker of this.signMarkers) marker.setMap(this.signsVisible ? this.map : null);
    if (!this.signsVisible && this.activeSignMarker) {
      this.infoWindow.close();
      this.activeSignMarker = null;
    }
  }
}
