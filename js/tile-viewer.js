/**
 * Tile-backed Street View panorama viewer.
 * Uses Map Tiles API tiles as the only image source.
 */

class TileViewer {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "block";
    this.ctx = this.canvas.getContext("2d");
    this.container.innerHTML = "";
    this.container.appendChild(this.canvas);

    this._panoId = options.pano || null;
    this._heading = Number.isFinite(options?.pov?.heading) ? options.pov.heading : 0;
    this._pitch = Number.isFinite(options?.pov?.pitch) ? options.pov.pitch : 0;
    this._zoom = Number.isFinite(options?.pov?.zoom) ? options.pov.zoom : 1;
    this._panoHeading = 0;
    this._session = null;
    this._metadata = null;
    this._position = null;
    this._links = [];
    this._tileCache = new Map();
    this._listeners = new Map();
    this._renderQueued = false;
    this._destroyed = false;
    this._pointerState = null;

    this._boundPointerMove = this._onPointerMove.bind(this);
    this._boundPointerUp = this._onPointerUp.bind(this);
    this._boundWheel = this._onWheel.bind(this);
    this._boundPointerDown = this._onPointerDown.bind(this);

    this.canvas.addEventListener("pointerdown", this._boundPointerDown);
    this.canvas.addEventListener("wheel", this._boundWheel, { passive: false });

    this._resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => this._syncCanvasSize())
        : null;
    this._resizeObserver?.observe(this.container);
    window.addEventListener("resize", () => this._syncCanvasSize());
    this._syncCanvasSize();

    if (this._panoId) {
      this.setPano(this._panoId).catch((err) => {
        console.error("TileViewer init failed:", err);
      });
    } else {
      this._queueRender();
    }
  }

  getPov() {
    return { heading: this._heading, pitch: this._pitch, zoom: this._zoom };
  }

  setPov(pov = {}) {
    const nextHeading = Number.isFinite(pov.heading) ? pov.heading : this._heading;
    const nextZoom = Number.isFinite(pov.zoom) ? pov.zoom : this._zoom;
    this._heading = ((nextHeading % 360) + 360) % 360;
    this._pitch = 0;
    this._zoom = Math.max(0.5, Math.min(5, nextZoom));
    this._queueRender();
    this._emit("pov_changed");
  }

  getPano() {
    return this._panoId;
  }

  async setPano(panoId) {
    if (!panoId) return;
    const session = await getSessionToken();
    const metadata = await fetchStreetViewMetadata(panoId, session);
    let panoData = null;
    if (typeof resolveStreetViewPanorama === "function") {
      try {
        panoData = await resolveStreetViewPanorama({ pano: panoId }, 5000);
      } catch (err) {
        console.warn("TileViewer failed to resolve panorama metadata:", err);
      }
    }

    this._session = session;
    this._panoId = panoId;
    this._metadata = metadata || null;
    this._panoHeading = Number.isFinite(metadata?.heading) ? metadata.heading : 0;
    this._position = this._makeLatLng(
      panoData?.location?.latLng?.lat?.() ?? metadata?.lat,
      panoData?.location?.latLng?.lng?.() ?? metadata?.lng,
    );
    this._links = Array.isArray(panoData?.links) ? panoData.links : [];
    this._tileCache.clear();
    this._queueRender();
    this._emit("pano_changed");
    this._emit("position_changed");
  }

  getPosition() {
    return this._position;
  }

  getLinks() {
    return this._links;
  }

  addListener(eventName, callback) {
    if (!this._listeners.has(eventName)) {
      this._listeners.set(eventName, new Set());
    }
    const bucket = this._listeners.get(eventName);
    bucket.add(callback);
    return {
      remove: () => {
        bucket.delete(callback);
      },
    };
  }

  getContainer() {
    return this.container;
  }

  getViewportRect() {
    const canvasWidth = this.canvas.width || this.container.clientWidth || 1;
    const canvasHeight = this.canvas.height || this.container.clientHeight || 1;
    const hFov = zoomToFov(this._zoom || 1);
    const halfBandDegrees =
      window.DETECTION_CONFIG?.HORIZON_HALF_BAND_DEGREES ?? 10;
    const center = headingPitchToPixel(
      this._heading,
      0,
      TILE_GRID_WIDTH,
      TILE_GRID_HEIGHT,
      this._panoHeading,
    );
    const topBandPoint = headingPitchToPixel(
      this._heading,
      halfBandDegrees,
      TILE_GRID_WIDTH,
      TILE_GRID_HEIGHT,
      this._panoHeading,
    );
    const bottomBandPoint = headingPitchToPixel(
      this._heading,
      -halfBandDegrees,
      TILE_GRID_WIDTH,
      TILE_GRID_HEIGHT,
      this._panoHeading,
    );
    const width = (hFov / 360) * TILE_GRID_WIDTH;
    const height = Math.max(1, Math.abs(bottomBandPoint.y - topBandPoint.y));
    const sourceAspect = width / height;
    let drawWidth = canvasWidth;
    let drawHeight = drawWidth / sourceAspect;
    if (drawHeight > canvasHeight) {
      drawHeight = canvasHeight;
      drawWidth = drawHeight * sourceAspect;
    }
    const drawLeft = (canvasWidth - drawWidth) / 2;
    const drawTop = (canvasHeight - drawHeight) / 2;
    return {
      centerX: center.x,
      centerY: (topBandPoint.y + bottomBandPoint.y) / 2,
      left: center.x - width / 2,
      top: Math.min(topBandPoint.y, bottomBandPoint.y),
      width,
      height,
      panoWidth: TILE_GRID_WIDTH,
      panoHeight: TILE_GRID_HEIGHT,
      panoHeading: this._panoHeading,
      canvasWidth,
      canvasHeight,
      hFov,
      vFov: halfBandDegrees * 2,
      drawLeft,
      drawTop,
      drawWidth,
      drawHeight,
    };
  }

  getVisibleTileSelection() {
    const rect = this.getViewportRect();
    const tileY1 = Math.max(0, Math.floor(rect.top / TILE_SIZE));
    const tileY2 = Math.min(15, Math.floor((rect.top + rect.height) / TILE_SIZE));
    const tiles = [];
    const minTileX = Math.floor(rect.left / TILE_SIZE);
    const maxTileX = Math.floor((rect.left + rect.width) / TILE_SIZE);

    for (let ty = tileY1; ty <= tileY2; ty += 1) {
      for (let tx = minTileX; tx <= maxTileX; tx += 1) {
        tiles.push({ x: tx, y: ty });
      }
    }

    return {
      tiles,
      tileX1: minTileX,
      tileY1,
      viewportRect: rect,
    };
  }

  panoPixelToScreen(x, y) {
    const rect = this.getViewportRect();
    const dx = this._wrapDelta(x - rect.centerX, rect.panoWidth);
    const dy = y - rect.centerY;
    return {
      x: rect.drawLeft + rect.drawWidth / 2 + (dx / rect.width) * rect.drawWidth,
      y: rect.drawTop + rect.drawHeight / 2 + (dy / rect.height) * rect.drawHeight,
    };
  }

  screenToPanoPixel(screenX, screenY) {
    const rect = this.getViewportRect();
    const dy =
      ((screenY - (rect.drawTop + rect.drawHeight / 2)) / rect.drawHeight) *
      rect.height;
    return {
      x:
        rect.centerX +
        ((screenX - (rect.drawLeft + rect.drawWidth / 2)) / rect.drawWidth) *
          rect.width,
      y: Math.max(0, Math.min(TILE_GRID_HEIGHT, rect.centerY + dy)),
    };
  }

  destroy() {
    this._destroyed = true;
    this.canvas.removeEventListener("pointerdown", this._boundPointerDown);
    this.canvas.removeEventListener("wheel", this._boundWheel);
    window.removeEventListener("pointermove", this._boundPointerMove);
    window.removeEventListener("pointerup", this._boundPointerUp);
    this._resizeObserver?.disconnect();
  }

  _emit(eventName) {
    const listeners = this._listeners.get(eventName);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        console.warn(`TileViewer listener failed for ${eventName}:`, err);
      }
    }
  }

  _makeLatLng(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat: () => lat, lng: () => lng };
  }

  _syncCanvasSize() {
    const width = Math.max(1, Math.floor(this.container.clientWidth || 1));
    const height = Math.max(1, Math.floor(this.container.clientHeight || 1));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this._queueRender();
    }
  }

  _onPointerDown(event) {
    event.preventDefault();
    this.canvas.setPointerCapture?.(event.pointerId);
    this._pointerState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      heading: this._heading,
    };
    window.addEventListener("pointermove", this._boundPointerMove);
    window.addEventListener("pointerup", this._boundPointerUp);
  }

  _onPointerMove(event) {
    if (!this._pointerState || event.pointerId !== this._pointerState.pointerId) return;
    const rect = this.getViewportRect();
    const dx = event.clientX - this._pointerState.startX;
    const headingDelta = (dx / Math.max(rect.canvasWidth, 1)) * rect.hFov;
    this._heading = ((this._pointerState.heading - headingDelta) % 360 + 360) % 360;
    this._pitch = 0;
    this._queueRender();
    this._emit("pov_changed");
  }

  _onPointerUp(event) {
    if (!this._pointerState || event.pointerId !== this._pointerState.pointerId) return;
    this.canvas.releasePointerCapture?.(event.pointerId);
    this._pointerState = null;
    window.removeEventListener("pointermove", this._boundPointerMove);
    window.removeEventListener("pointerup", this._boundPointerUp);
  }

  _onWheel(event) {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.25 : 0.25;
    this.setPov({ zoom: this._zoom + delta });
  }

  _queueRender() {
    if (this._renderQueued || this._destroyed) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this._render();
    });
  }

  async _render() {
    const ctx = this.ctx;
    if (!ctx) return;

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this._panoId || !this._session) return;

    const visible = this.getVisibleTileSelection();
    await Promise.allSettled(visible.tiles.map((tile) => this._ensureTile(tile.x, tile.y)));

    for (const tile of visible.tiles) {
      const key = `${this._panoId},${tile.x},${tile.y}`;
      const img = this._tileCache.get(key);
      if (!img) continue;

      const start = this.panoPixelToScreen(tile.x * TILE_SIZE, tile.y * TILE_SIZE);
      const end = this.panoPixelToScreen((tile.x + 1) * TILE_SIZE, (tile.y + 1) * TILE_SIZE);
      const drawX = Math.min(start.x, end.x);
      const drawY = Math.min(start.y, end.y);
      const drawW = Math.abs(end.x - start.x);
      const drawH = Math.abs(end.y - start.y);
      if (drawW <= 0 || drawH <= 0) continue;
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
    }
  }

  async _ensureTile(tileX, tileY) {
    const panoId = this._panoId;
    const key = `${panoId},${tileX},${tileY}`;
    if (this._tileCache.has(key)) {
      return this._tileCache.get(key);
    }

    const safeX = ((tileX % 32) + 32) % 32;
    const safeY = Math.max(0, Math.min(15, tileY));
    const apiKey = window.GOOGLE_CONFIG?.API_KEY;
    const url =
      `https://tile.googleapis.com/v1/streetview/tiles/5/${safeX}/${safeY}` +
      `?session=${this._session}&key=${apiKey}&panoId=${panoId}`;
    const img = new Image();
    img.crossOrigin = "anonymous";

    const loaded = await new Promise((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load tile ${key}`));
      img.src = url;
    }).catch((err) => {
      console.warn(err.message);
      return null;
    });

    // Discard tile if pano changed while fetching
    if (loaded && this._panoId === panoId) {
      this._tileCache.set(key, loaded);
    }
    return loaded;
  }

  _wrapDelta(delta, total) {
    let wrapped = delta % total;
    if (wrapped > total / 2) wrapped -= total;
    if (wrapped < -total / 2) wrapped += total;
    return wrapped;
  }
}

window.TileViewer = TileViewer;
