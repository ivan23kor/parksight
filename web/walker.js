import { PILOT } from "./config.js";

export function bearing(from, to) {
  const radians = Math.PI / 180;
  const first = from.lat() * radians;
  const second = to.lat * radians;
  const delta = (to.lng - from.lng()) * radians;
  const east = Math.sin(delta) * Math.cos(second);
  const north = Math.cos(first) * Math.sin(second)
    - Math.sin(first) * Math.cos(second) * Math.cos(delta);
  return (Math.atan2(east, north) / radians + 360) % 360;
}

export class PanoramaWalker {
  constructor(onChange) {
    this.onChange = onChange;
    this.requestId = 0;
  }

  async start() {
    this.service = new google.maps.StreetViewService();
    this.panorama = new google.maps.StreetViewPanorama(document.getElementById("streetview"), {
      pov: { heading: 0, pitch: 0 },
      zoom: 0,
      addressControl: false,
      fullscreenControl: false,
      motionTracking: false,
      showRoadLabels: true,
      linksControl: true,
      panControl: true,
      zoomControl: true,
    });
    document.getElementById("walkerPlaceholder")?.remove();
    this.panorama.addListener("position_changed", () => this.onChange?.(this.panorama.getPosition()));
    await this.openLocation(...PILOT.tower);
  }

  openLocation(lat, lng) {
    if (!this.service) return Promise.reject(new Error("Street View is unavailable."));
    const requestId = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.service.getPanorama({
        location: { lat, lng },
        radius: 90,
        sources: [google.maps.StreetViewSource.GOOGLE, google.maps.StreetViewSource.OUTDOOR],
        preference: google.maps.StreetViewPreference.NEAREST,
      }, (data, status) => {
        if (requestId !== this.requestId) return resolve(null);
        if (status !== google.maps.StreetViewStatus.OK || !data?.location?.pano) {
          reject(new Error("No outdoor Street View near this selection."));
          return;
        }
        this.panorama.setPano(data.location.pano);
        const position = data.location.latLng || this.panorama.getPosition();
        this.panorama.setPov({
          heading: position ? bearing(position, { lat, lng }) : 0,
          pitch: 0,
        });
        resolve(data);
      });
    });
  }
}
