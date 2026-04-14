/**
 * three-overlay.js
 * Urban Layers — self-contained Three.js WebGL massing layer over Leaflet.
 *
 * Importing:
 *   const { ThreeOverlay } = await import('./three-overlay.js');
 *
 * Typical usage in a render loop:
 *   const overlay = new ThreeOverlay(map, { categories: CATEGORIES });
 *   await overlay.show();               // lazy-loads Three.js, binds map events
 *
 *   // Called after every data/year/filter change:
 *   overlay.clearBuildings();
 *   for (const r of visibleRecords) overlay.addBuilding(r, { ghost });
 *   overlay.render();
 *
 *   overlay.hide();                     // toggle back to 2D
 *
 * Category colours are read from CSS custom properties (--color-<category>)
 * so the single colour source-of-truth is the :root block in index.html.
 * The `categories` constructor option is used as a fallback when the
 * CSS property is absent.
 *
 * Design notes
 * ─────────────
 * • One WebGLRenderer canvas, created and owned by this class, appended to the
 *   map container element as an absolutely-positioned child.
 * • Two InstancedMesh objects (normal + ghost) collapse all buildings into two
 *   GPU draw calls regardless of record count.
 * • OrthographicCamera tilted ~23.6° from vertical produces an isometric depth
 *   effect: taller buildings visually "rise" above their map footprint.
 * • Projection delegates to map.latLngToContainerPoint so 3D positions stay
 *   pixel-perfect with Leaflet's own marker positions at all zoom levels.
 * • Map move/zoom/resize events are handled internally; callers do not need to
 *   re-add buildings on viewport changes — the stored list is re-projected.
 */

const THREE_CDN     = "https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js";
const MAX_INSTANCES = 1000;

// Year → height mapping (placeholder until real floor-count data exists).
// Linear ramp: oldest record in BASE_RECORDS → minimum height,
//              slider max year                → maximum height.
const YEAR_LO   = 1791;   // Mission Dolores
const YEAR_HI   = 2000;
const HEIGHT_LO = 0.008;  // Three.js world-space units (NDC fraction)
const HEIGHT_HI = 0.055;

// Camera tilt: position at (0, CAM_Y, CAM_Z) looking at origin gives
//   atan(|CAM_Y| / CAM_Z) ≈ 23.6° from vertical → isometric depth feel.
// Buildings of height h appear ≈ 0.40·h NDC units above their footprint.
const CAM_Y = -0.4;
const CAM_Z =  0.915;

// ─────────────────────────────────────────────────────────────────────────────

export class ThreeOverlay {
  /**
   * @param {L.Map} map  The Leaflet map instance to overlay.
   * @param {object} [options]
   * @param {object} [options.categories]
   *   Map of category key → `{ color: '#rrggbb' }`.
   *   Used as a fallback when --color-<key> CSS variable is not defined.
   * @param {string} [options.containerId="map-container"]
   *   ID of the DOM element the canvas is appended to.
   *   Must have `position: relative | absolute | fixed`.
   */
  constructor(map, { categories = {}, containerId = "map-container" } = {}) {
    this._map        = map;
    this._categories = categories;
    this._buildings  = [];  // [{ record, ghost: boolean }]

    // Three.js objects — null until _ensureInit() resolves
    this._THREE      = null;
    this._ready      = false;
    this._renderer   = null;
    this._scene      = null;
    this._camera     = null;
    this._meshNormal = null;
    this._meshGhost  = null;
    this._dummy      = null;  // scratch Object3D for matrix construction
    this._color      = null;  // scratch Color for per-instance colouring

    this._canvas = this._createCanvas(containerId);

    // Pre-bind handlers so the same reference works for both .on() and .off()
    this._onMove   = this._handleMove.bind(this);
    this._onResize = this._handleResize.bind(this);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Lazy-load Three.js, make the canvas visible, and start listening to
   * Leaflet viewport events. Safe to call every time the toggle fires —
   * subsequent calls return immediately after the first init.
   */
  async show() {
    await this._ensureInit();
    this._canvas.style.display = "";
    this._map.on("moveend zoomend", this._onMove);
    this._map.on("resize",          this._onResize);
    this._syncAspect();
  }

  /**
   * Hide the canvas and stop responding to map events.
   * The Three.js renderer and scene are kept alive so the next show() is free.
   */
  hide() {
    this._canvas.style.display = "none";
    this._map.off("moveend zoomend", this._onMove);
    this._map.off("resize",          this._onResize);
  }

  /**
   * Add one building to the draw queue for the next render() call.
   *
   * @param {object} record  Must have: lat, lng (numbers), year (integer),
   *                         category (string matching a CATEGORIES key).
   * @param {{ ghost?: boolean }} [opts]
   *   ghost: true → drawn translucent (demolished-but-visible state).
   */
  addBuilding(record, { ghost = false } = {}) {
    this._buildings.push({ record, ghost });
  }

  /**
   * Clear the draw queue. Call this before re-adding buildings for a new frame
   * (e.g. when the year slider or category filter changes).
   */
  clearBuildings() {
    this._buildings = [];
  }

  /**
   * Rebuild the InstancedMesh buffers from the current building list and draw
   * one WebGL frame. No-op before show() has resolved.
   *
   * Call this after all addBuilding() calls for a given frame.
   */
  render() {
    if (!this._ready) return;
    this._rebuildMesh();
    this._renderFrame();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /** Create the overlay canvas and append it to the map container. */
  _createCanvas(containerId) {
    const wrap = document.getElementById(containerId);
    if (!wrap) throw new Error(`ThreeOverlay: #${containerId} not found`);

    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, {
      position:      "absolute",
      top:           "0",
      left:          "0",
      width:         "100%",
      height:        "100%",
      pointerEvents: "none",   // clicks fall through to Leaflet
      zIndex:        "400",
      display:       "none",
    });
    wrap.appendChild(canvas);
    return canvas;
  }

  /** Initialise Three.js on the first call; subsequent calls are instant. */
  async _ensureInit() {
    if (this._ready) return;

    const THREE = await import(THREE_CDN);
    this._THREE = THREE;

    const sz  = this._map.getSize();
    const asp = sz.x / sz.y;

    // ── Renderer ──────────────────────────────────────────────────────────────
    this._renderer = new THREE.WebGLRenderer({
      canvas:    this._canvas,
      alpha:     true,        // transparent background so Leaflet shows through
      antialias: true,
    });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setSize(sz.x, sz.y, false); // false = don't update canvas CSS

    // ── Scene ─────────────────────────────────────────────────────────────────
    this._scene = new THREE.Scene();
    this._dummy = new THREE.Object3D();
    this._color = new THREE.Color();

    // Warm ambient fill keeps unlit faces visible; directional from upper-left
    // casts face shadows that reveal building volume.
    this._scene.add(new THREE.AmbientLight(0xffeedd, 0.5));
    const dir = new THREE.DirectionalLight(0xffd080, 1.0);
    dir.position.set(-0.6, -0.8, 1.5);
    this._scene.add(dir);

    // ── Camera ────────────────────────────────────────────────────────────────
    // OrthographicCamera: frustum spans [-asp, asp] × [-1, 1] so one NDC unit
    // equals half the canvas height in both axes. Positioned off-vertical by
    // ~23.6° for an isometric tilt without perspective distortion.
    this._camera = new THREE.OrthographicCamera(-asp, asp, 1, -1, -20, 20);
    this._camera.position.set(0, CAM_Y, CAM_Z);
    this._camera.lookAt(0, 0, 0);

    // ── InstancedMesh × 2 ─────────────────────────────────────────────────────
    // Separate meshes for normal and ghost buildings allow per-mesh opacity
    // without a custom shader. renderOrder = 1 on ghost ensures the transparent
    // pass draws after all opaque geometry.
    const geo = new THREE.BoxGeometry(1, 1, 1); // unit cube — scaled via dummy

    this._meshNormal = new THREE.InstancedMesh(
      geo,
      new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 55 }),
      MAX_INSTANCES,
    );
    this._meshGhost = new THREE.InstancedMesh(
      geo,
      new THREE.MeshPhongMaterial({
        vertexColors: true,
        transparent:  true,
        opacity:      0.28,
        shininess:    20,
      }),
      MAX_INSTANCES,
    );

    this._meshNormal.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._meshGhost.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._meshNormal.count = 0;
    this._meshGhost.count  = 0;
    this._meshGhost.renderOrder = 1;

    this._scene.add(this._meshNormal, this._meshGhost);
    this._ready = true;
  }

  /**
   * Convert WGS-84 lat/lng to Three.js world space by delegating to Leaflet's
   * latLngToContainerPoint. This guarantees that 3D box footprints are
   * pixel-aligned with Leaflet's own SVG/canvas markers at every zoom level,
   * bearing, and projection.
   */
  _project(lat, lng) {
    const pt  = this._map.latLngToContainerPoint([lat, lng]);
    const sz  = this._map.getSize();
    const asp = sz.x / sz.y;
    return {
      x:  ((pt.x / sz.x) * 2 - 1) * asp,
      y: -((pt.y / sz.y) * 2 - 1),
    };
  }

  /**
   * Map construction year to extrusion height (world units).
   * Older = shorter, newer = taller — placeholder until real height data exists.
   */
  _yearToHeight(year) {
    const t = Math.max(0, Math.min(1, (year - YEAR_LO) / (YEAR_HI - YEAR_LO)));
    return HEIGHT_LO + t * (HEIGHT_HI - HEIGHT_LO);
  }

  /**
   * Building footprint width in world units.
   * Zoom-adaptive: doubles per zoom step, capped at zoom 16 to prevent boxes
   * from filling the screen on very deep zooms.
   */
  _footprintWidth() {
    const sz  = this._map.getSize();
    const asp = sz.x / sz.y;
    const px  = 12 * Math.pow(2, Math.min(this._map.getZoom(), 16) - 13);
    return (px / sz.x) * 2 * asp;
  }

  /**
   * Resolve the fill colour for a category.
   *
   * Priority order:
   *   1. CSS custom property  --color-<category>  on :root
   *      (defined in index.html; single source of truth for the palette)
   *   2. categories[category].color  from the constructor option
   *   3. Grey fallback
   */
  _categoryColor(category) {
    const fromCss = getComputedStyle(document.documentElement)
      .getPropertyValue(`--color-${category}`)
      .trim();
    return fromCss || this._categories[category]?.color || "#888888";
  }

  /** Resize renderer and update camera frustum to match the container. */
  _syncAspect() {
    const sz  = this._map.getSize();
    const asp = sz.x / sz.y;
    this._renderer.setSize(sz.x, sz.y, false);
    this._camera.left  = -asp;
    this._camera.right =  asp;
    this._camera.updateProjectionMatrix();
  }

  /**
   * Rebuild InstancedMesh buffers from the current _buildings list.
   * Each building re-projects from the current Leaflet viewport, so calling
   * this after any map move/zoom automatically re-aligns the 3D layer.
   */
  _rebuildMesh() {
    const w = this._footprintWidth();
    let nc = 0, gc = 0;

    for (const { record: r, ghost } of this._buildings) {
      if (nc + gc >= MAX_INSTANCES) break;

      const { x, y } = this._project(r.lat, r.lng);
      const h        = this._yearToHeight(r.year);

      // Centre the box at z = h/2 so its base rests at z = 0 (ground plane).
      this._dummy.position.set(x, y, h / 2);
      this._dummy.scale.set(w, w, h);
      this._dummy.rotation.set(0, 0, 0);
      this._dummy.updateMatrix();

      this._color.set(this._categoryColor(r.category));

      if (!ghost) {
        this._meshNormal.setMatrixAt(nc, this._dummy.matrix);
        this._meshNormal.setColorAt(nc, this._color);
        nc++;
      } else {
        this._meshGhost.setMatrixAt(gc, this._dummy.matrix);
        this._meshGhost.setColorAt(gc, this._color);
        gc++;
      }
    }

    this._meshNormal.count = nc;
    this._meshGhost.count  = gc;
    this._meshNormal.instanceMatrix.needsUpdate = true;
    this._meshGhost.instanceMatrix.needsUpdate  = true;
    if (this._meshNormal.instanceColor) this._meshNormal.instanceColor.needsUpdate = true;
    if (this._meshGhost.instanceColor)  this._meshGhost.instanceColor.needsUpdate  = true;
  }

  _renderFrame() {
    this._renderer.render(this._scene, this._camera);
  }

  // ── Leaflet event handlers ───────────────────────────────────────────────────

  /**
   * On moveend / zoomend: re-project stored buildings to the new viewport and
   * redraw. No need for the caller to re-call addBuilding — the list is stable
   * between slider/filter changes, only positions change on pan/zoom.
   */
  _handleMove() {
    if (!this._ready) return;
    this._rebuildMesh();
    this._renderFrame();
  }

  /**
   * On Leaflet resize: update renderer resolution and camera aspect ratio
   * before redrawing, so the canvas fills the new container dimensions.
   */
  _handleResize() {
    if (!this._ready) return;
    this._syncAspect();
    this._rebuildMesh();
    this._renderFrame();
  }
}
