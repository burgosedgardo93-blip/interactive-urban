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
 *   await overlay.enableControls(onSelect); // attach OrbitControls + raycasting
 *
 *   // Called after every data/year/filter change:
 *   overlay.clearBuildings();
 *   for (const r of visibleRecords) overlay.addBuilding(r, { ghost });
 *   overlay.render();
 *
 *   overlay.disableControls();          // back to Leaflet-only interaction
 *   overlay.hide();                     // toggle back to 2D
 *
 * Design notes
 * ─────────────
 * • One WebGLRenderer canvas, created and owned by this class, appended to the
 *   map container element as an absolutely-positioned child.
 * • Ten InstancedMesh objects (five eras × solid + wireframe) replace the
 *   original two meshes, giving each historical period its own material while
 *   still collapsing per-era buildings into a single GPU draw call.
 * • Buildings demolished as the year slider moves animate from solid to
 *   wireframe over ANIM_MS milliseconds via individually spawned Mesh objects
 *   that are promoted to the wireframe InstancedMesh pool once complete.
 * • OrthographicCamera tilted ~23.6° from vertical produces an isometric depth
 *   effect: taller buildings visually "rise" above their map footprint.
 * • Projection delegates to map.latLngToContainerPoint so 3D positions stay
 *   pixel-perfect with Leaflet's own marker positions at all zoom levels.
 * • Map move/zoom/resize events are handled internally; callers do not need to
 *   re-add buildings on viewport changes — the stored list is re-projected.
 * • Lighting: one warm 3000 K directional light + one ambient fill light.
 *
 * Camera controls (3D mode)
 * ──────────────────────────
 * • enableControls(onSelect) enables OrbitControls on the camera canvas.
 *   OrbitControls is imported lazily from the three.js CDN examples/jsm path.
 *   Requires an importmap in the host page mapping "three" to the same CDN URL
 *   used by THREE_CDN so that both modules share the same Three.js instance.
 * • Orbit is constrained: max polar angle 75° (no underground), zoom 0.2–8 ×.
 * • Click on a building: raycasts against all 10 InstancedMesh, highlights the
 *   hit building with an emissive category-coloured overlay mesh, fires onSelect.
 * • Double-click on empty space: resets camera to default isometric position
 *   over 800 ms via a smooth ease-in-out lerp.
 * • flyTo(record): animates camera to face the building at 45° over FLY_MS ms.
 * • disableControls() removes event listeners, stops the rAF loop, and clears
 *   any active selection highlight.
 */

import { eraIndex, createMaterials } from './material-factory.js';

const THREE_CDN     = "https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js";
const ORBIT_CDN     = "https://cdn.jsdelivr.net/npm/three@0.162.0/examples/jsm/controls/OrbitControls.js";
const MAX_INSTANCES = 1000;
const ANIM_MS       = 600;   // solid → wireframe transition duration (ms)
const FLY_MS        = 800;   // fly-to camera animation duration (ms)

// Orbit constraints
const MAX_POLAR_ANGLE = Math.PI * 75 / 180;  // 75° from vertical — no going underground
const MIN_ZOOM        = 0.2;   // far out, city overview
const MAX_ZOOM        = 8.0;   // close up, individual building

// Year → height mapping (placeholder until real floor-count data exists).
const YEAR_LO   = 1791;   // Mission Dolores
const YEAR_HI   = 2000;
const HEIGHT_LO = 0.008;  // Three.js world-space units (NDC fraction)
const HEIGHT_HI = 0.055;

// Scale factor: 1 metre of real building height → world-space NDC units.
const METERS_TO_NDC = 0.00157;

// Camera tilt: position at (0, CAM_Y, CAM_Z) gives ~23.6° isometric tilt.
const CAM_Y = -0.4;
const CAM_Z =  0.915;

// 3000 K blackbody approximation: R=255, G=178, B=102  →  0xffb266
const LIGHT_3000K     = 0xffb266;
const LIGHT_AMBIENT   = 0xffe8d0;

// ─────────────────────────────────────────────────────────────────────────────

export class ThreeOverlay {
  /**
   * @param {L.Map} map  The Leaflet map instance to overlay.
   * @param {object} [options]
   * @param {object} [options.categories]
   *   Map of category key → { color: '#rrggbb' }. Used for selection highlight
   *   colours; the 3D layer colours buildings by era, not category.
   * @param {string} [options.containerId="map-container"]
   *   ID of the DOM element the canvas is appended to.
   */
  constructor(map, { categories = {}, containerId = "map-container" } = {}) {
    this._map        = map;
    this._categories = categories;
    this._buildings  = [];  // [{ record, ghost: boolean, heightM: number|null }]

    // Three.js objects — null until _ensureInit() resolves
    this._THREE       = null;
    this._ready       = false;
    this._renderer    = null;
    this._scene       = null;
    this._camera      = null;
    this._solidMeshes = null;  // Array[5]: InstancedMesh per era — standing buildings
    this._wireMeshes  = null;  // Array[5]: InstancedMesh per era — demolished ghosts
    this._materials   = null;  // Array[5]: { solid, wireframe } from createMaterials()
    this._dummy       = null;  // scratch Object3D for matrix construction

    // Per-building state tracking for the demolition animation
    this._prevStates     = new Map();  // id → ghost(bool) as of last _rebuildMesh()
    this._animating      = new Map();  // id → { startMs, solidMesh, wireMesh, lat, lng, heightM, year }
    this._animLoopActive = false;

    // ── Raycasting: instance-index → record mapping ─────────────────────────
    // _instanceRecords[0..4]  = solidMeshes[0..4] instance arrays
    // _instanceRecords[5..9]  = wireMeshes[0..4]  instance arrays
    this._instanceRecords = null;

    // ── OrbitControls ────────────────────────────────────────────────────────
    this._OrbitControlsClass = null;
    this._controls           = null;
    this._controlsLoopActive = false;
    this._controlsRafId      = null;

    // ── Selection highlight ──────────────────────────────────────────────────
    this._selectedRecord = null;
    this._highlightMesh  = null;

    // ── Fly-to animation ─────────────────────────────────────────────────────
    this._flyAnim = null;

    // ── Callbacks ────────────────────────────────────────────────────────────
    this._onSelect   = null;
    this._onClick    = this._handleClick.bind(this);
    this._onDblClick = this._handleDblClick.bind(this);

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
    this._stopControlsLoop();
  }

  /**
   * Add one building to the draw queue for the next render() call.
   *
   * @param {object} record  Must have: id, lat, lng (numbers), year (integer).
   * @param {{ ghost?: boolean, heightM?: number|null }} [opts]
   *   ghost:   true → demolished before the current view year.
   *   heightM: real building height in metres; null falls back to year heuristic.
   */
  addBuilding(record, { ghost = false, heightM = null } = {}) {
    this._buildings.push({ record, ghost, heightM });
  }

  /**
   * Clear the draw queue. Call this before re-adding buildings for a new frame.
   * Does NOT clear the previous-state map used for transition detection.
   */
  clearBuildings() {
    this._buildings = [];
  }

  /**
   * Rebuild InstancedMesh buffers and draw one WebGL frame. No-op before
   * show() has resolved. Call after all addBuilding() calls for a given frame.
   */
  render() {
    if (!this._ready) return;
    this._rebuildMesh();
    this._renderFrame();
  }

  /**
   * Attach OrbitControls to the camera canvas, enabling 3D-native navigation.
   *
   * Lazily imports OrbitControls from the CDN on the first call.  Requires an
   * importmap in the host page that maps "three" → the same CDN URL used by
   * THREE_CDN so both share one module instance.
   *
   * @param {function(record|null): void} [onSelect]
   *   Called with the clicked record (or null for empty-space clicks).
   */
  async enableControls(onSelect) {
    if (!this._ready) await this._ensureInit();
    this._onSelect = onSelect ?? null;

    // Lazy-load OrbitControls once
    if (!this._OrbitControlsClass) {
      const { OrbitControls } = await import(ORBIT_CDN);
      this._OrbitControlsClass = OrbitControls;
    }

    if (!this._controls) {
      this._controls = new this._OrbitControlsClass(this._camera, this._canvas);
      this._controls.maxPolarAngle      = MAX_POLAR_ANGLE;
      this._controls.minZoom            = MIN_ZOOM;
      this._controls.maxZoom            = MAX_ZOOM;
      this._controls.enableDamping      = true;
      this._controls.dampingFactor      = 0.08;
      this._controls.screenSpacePanning = true;
      this._controls.zoomToCursor       = true;
    }

    this._controls.enabled = true;
    this._canvas.style.pointerEvents = "auto";
    this._canvas.addEventListener("click",    this._onClick);
    this._canvas.addEventListener("dblclick", this._onDblClick);
    this._startControlsLoop();
  }

  /**
   * Detach OrbitControls, restore pointer-events passthrough, and clear any
   * active building selection.
   */
  disableControls() {
    this._stopControlsLoop();
    if (this._controls) this._controls.enabled = false;
    this._canvas.style.pointerEvents = "none";
    this._canvas.removeEventListener("click",    this._onClick);
    this._canvas.removeEventListener("dblclick", this._onDblClick);
    this._clearSelection();
    if (this._flyAnim) {
      cancelAnimationFrame(this._flyAnim.rafId);
      this._flyAnim = null;
    }
  }

  /**
   * Smoothly fly the camera to face `record` at 45° elevation over FLY_MS ms.
   * No-op if controls have not been enabled.
   *
   * @param {object} record  Must have lat, lng, year (and optionally heightM
   *   stored in the building cache).
   */
  flyTo(record) {
    if (!this._ready || !this._controls) return;
    const { x, y } = this._project(record.lat, record.lng);
    // Orbit target = building base; camera = 45° above at distance d
    const d      = 0.12; // ~76 m in NDC world units
    const inv    = Math.SQRT1_2; // 1/√2 ≈ 0.707
    const THREE  = this._THREE;
    const target = new THREE.Vector3(x, y, 0);
    const cam    = new THREE.Vector3(x, y - d * inv, d * inv);
    this._startFlyAnim(cam, target, 2.5);
  }

  /**
   * Animate the camera back to the default isometric overview position.
   * No-op if controls have not been enabled.
   */
  resetCamera() {
    if (!this._ready || !this._controls) return;
    const THREE  = this._THREE;
    const cam    = new THREE.Vector3(0, CAM_Y, CAM_Z);
    const target = new THREE.Vector3(0, 0, 0);
    this._startFlyAnim(cam, target, 1.0);
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
      pointerEvents: "none",   // clicks fall through to Leaflet by default
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

    // One warm ambient fill + one 3000 K directional from upper-left.
    this._scene.add(new THREE.AmbientLight(LIGHT_AMBIENT, 0.55));
    const dir = new THREE.DirectionalLight(LIGHT_3000K, 1.1);
    dir.position.set(-0.6, -0.8, 1.5);
    this._scene.add(dir);

    // ── Camera ────────────────────────────────────────────────────────────────
    // OrthographicCamera: frustum spans [-asp, asp] × [-1, 1] so one NDC unit
    // equals half the canvas height. Positioned off-vertical by ~23.6° for an
    // isometric tilt without perspective distortion.
    this._camera = new THREE.OrthographicCamera(-asp, asp, 1, -1, -20, 20);
    this._camera.position.set(0, CAM_Y, CAM_Z);
    this._camera.lookAt(0, 0, 0);

    // ── Era materials ─────────────────────────────────────────────────────────
    this._materials = createMaterials(THREE);

    // ── InstancedMesh × 10 ────────────────────────────────────────────────────
    // One solid + one wireframe InstancedMesh per era (5 × 2 = 10 meshes).
    // All share the same unit-cube geometry; scale is applied per-instance via
    // dummy.matrix in _rebuildMesh(). renderOrder = 1 on wireframe meshes
    // ensures the transparent pass draws after all opaque solid geometry.
    const geo = new THREE.BoxGeometry(1, 1, 1);

    this._solidMeshes = this._materials.map(m => {
      const mesh = new THREE.InstancedMesh(geo, m.solid, MAX_INSTANCES);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      return mesh;
    });

    this._wireMeshes = this._materials.map(m => {
      const mesh = new THREE.InstancedMesh(geo, m.wireframe, MAX_INSTANCES);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.renderOrder = 1;
      return mesh;
    });

    this._solidMeshes.forEach(m => this._scene.add(m));
    this._wireMeshes.forEach(m  => this._scene.add(m));

    this._ready = true;
  }

  /**
   * Convert WGS-84 lat/lng to Three.js world space via Leaflet's container-
   * point projection. Guarantees pixel-alignment with Leaflet markers at every
   * zoom level and projection.
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
   * Placeholder linear ramp: older = shorter, newer = taller.
   */
  _yearToHeight(year) {
    const t = Math.max(0, Math.min(1, (year - YEAR_LO) / (YEAR_HI - YEAR_LO)));
    return HEIGHT_LO + t * (HEIGHT_HI - HEIGHT_LO);
  }

  /**
   * Building footprint width in world units.
   * Zoom-adaptive: doubles per zoom step, capped at zoom 16.
   */
  _footprintWidth() {
    const sz  = this._map.getSize();
    const asp = sz.x / sz.y;
    const px  = 12 * Math.pow(2, Math.min(this._map.getZoom(), 16) - 13);
    return (px / sz.x) * 2 * asp;
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

  // ── OrbitControls loop ───────────────────────────────────────────────────────

  /**
   * Start a continuous rAF loop that calls controls.update() each frame so
   * that OrbitControls damping settles smoothly.  The loop renders only when
   * the controls report a change, keeping GPU work to a minimum at idle.
   */
  _startControlsLoop() {
    if (this._controlsLoopActive) return;
    this._controlsLoopActive = true;
    const loop = () => {
      if (!this._controlsLoopActive) return;
      if (this._controls?.enabled) {
        this._controls.update();
        this._renderFrame();
      }
      this._controlsRafId = requestAnimationFrame(loop);
    };
    this._controlsRafId = requestAnimationFrame(loop);
  }

  _stopControlsLoop() {
    this._controlsLoopActive = false;
    if (this._controlsRafId !== null) {
      cancelAnimationFrame(this._controlsRafId);
      this._controlsRafId = null;
    }
  }

  // ── Fly-to animation ─────────────────────────────────────────────────────────

  /**
   * Animate camera from its current position to `targetCamPos`, orbit target
   * to `targetLookAt`, and camera.zoom to `targetZoom`, over FLY_MS ms with
   * an ease-in-out quad curve.
   */
  _startFlyAnim(targetCamPos, targetLookAt, targetZoom) {
    if (this._flyAnim) {
      cancelAnimationFrame(this._flyAnim.rafId);
      this._flyAnim = null;
    }

    const startCamPos = this._camera.position.clone();
    const startTarget = this._controls.target.clone();
    const startZoom   = this._camera.zoom;
    const startMs     = performance.now();

    const tick = () => {
      const raw  = Math.min(1, (performance.now() - startMs) / FLY_MS);
      const ease = raw < 0.5 ? 2 * raw * raw : -1 + (4 - 2 * raw) * raw;

      this._camera.position.lerpVectors(startCamPos, targetCamPos, ease);
      this._controls.target.lerpVectors(startTarget, targetLookAt, ease);
      this._camera.zoom = startZoom + (targetZoom - startZoom) * ease;
      this._camera.updateProjectionMatrix();
      this._controls.update();
      this._renderFrame();

      if (raw < 1) {
        this._flyAnim = { rafId: requestAnimationFrame(tick) };
      } else {
        this._flyAnim = null;
      }
    };

    this._flyAnim = { rafId: requestAnimationFrame(tick) };
  }

  // ── Click handling & raycasting ──────────────────────────────────────────────

  _handleClick(event) {
    if (!this._ready || !this._instanceRecords) return;
    const record = this._raycastRecord(event);
    if (record) {
      this._selectRecord(record);
    } else {
      this._clearSelection();
    }
    if (this._onSelect) this._onSelect(record ?? null);
  }

  _handleDblClick(event) {
    if (!this._ready) return;
    const record = this._raycastRecord(event);
    if (!record) this.resetCamera();
  }

  /**
   * Cast a ray from the click position into the scene and return the record
   * corresponding to the nearest InstancedMesh hit, or null if no hit.
   */
  _raycastRecord(event) {
    const rect  = this._canvas.getBoundingClientRect();
    const ndcX  =  ((event.clientX - rect.left) / rect.width)  * 2 - 1;
    const ndcY  = -((event.clientY - rect.top)  / rect.height) * 2 + 1;
    const THREE = this._THREE;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this._camera);

    let nearest     = null;
    let nearestDist = Infinity;

    // solidMeshes → indices 0–4; wireMeshes → indices 5–9
    const allMeshes = [...this._solidMeshes, ...this._wireMeshes];
    for (let mi = 0; mi < allMeshes.length; mi++) {
      const hits = raycaster.intersectObject(allMeshes[mi]);
      if (hits.length > 0 && hits[0].distance < nearestDist) {
        const r = this._instanceRecords[mi]?.[hits[0].instanceId];
        if (r) {
          nearestDist = hits[0].distance;
          nearest     = r;
        }
      }
    }

    return nearest;
  }

  // ── Selection highlight ──────────────────────────────────────────────────────

  /**
   * Place a slightly oversized emissive overlay mesh on top of the selected
   * building so it glows in the building's category colour.
   */
  _selectRecord(r) {
    this._clearSelection();
    this._selectedRecord = r;

    const bldg = this._buildings.find(b => b.record.id === r.id);
    if (!bldg) return;

    const THREE    = this._THREE;
    const catHex   = this._categories[r.category]?.color ?? "#d4a857";
    const catColor = parseInt(catHex.replace("#", ""), 16);

    const { x, y } = this._project(r.lat, r.lng);
    const h        = bldg.heightM != null
      ? bldg.heightM * METERS_TO_NDC
      : this._yearToHeight(r.year);
    const w = this._footprintWidth();

    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({
      color:             catColor,
      emissive:          catColor,
      emissiveIntensity: 0.7,
      transparent:       true,
      opacity:           0.40,
      depthWrite:        false,
    });
    this._highlightMesh = new THREE.Mesh(geo, mat);
    this._highlightMesh.position.set(x, y, h / 2);
    this._highlightMesh.scale.set(w * 1.1, w * 1.1, h * 1.04);
    this._highlightMesh.renderOrder = 2;
    this._scene.add(this._highlightMesh);
    this._renderFrame();
  }

  _clearSelection() {
    if (this._highlightMesh) {
      this._scene.remove(this._highlightMesh);
      this._highlightMesh.geometry.dispose();
      this._highlightMesh.material.dispose();
      this._highlightMesh = null;
    }
    this._selectedRecord = null;
  }

  // ── Mesh rebuild ─────────────────────────────────────────────────────────────

  /**
   * Rebuild all InstancedMesh buffers from the current _buildings list.
   *
   * Three cases per building:
   *   1. Already animating (in _animating): re-project position only.
   *   2. Newly demolished this tick (prevState was normal → now ghost):
   *      spawn individual solid + wireframe Mesh objects and start the
   *      600 ms opacity animation.
   *   3. Steady state: write into the era's solid or wireframe InstancedMesh.
   *
   * Also maintains _instanceRecords[0..9] so raycasting can map instanceId
   * back to the original record object.
   *
   * Detecting slider reversal: if a building in _animating is no longer ghost,
   * the animation is cancelled and the building is shown solid immediately.
   */
  _rebuildMesh() {
    const w           = this._footprintWidth();
    const solidCounts = [0, 0, 0, 0, 0];
    const wireCounts  = [0, 0, 0, 0, 0];
    const newStates   = new Map();  // id → ghost(bool) — replaces _prevStates at end
    const instRecs    = Array.from({ length: 10 }, () => []);

    for (const { record: r, ghost, heightM } of this._buildings) {
      const ei = eraIndex(r.year);
      newStates.set(r.id, ghost);

      // ── Case 1a: animating but slider moved back — building is normal again ─
      if (this._animating.has(r.id) && !ghost) {
        this._removeAnim(r.id);
        // Fall through to steady-state solid rendering below.
      }

      // ── Case 1b: still animating toward demolished state — update position ──
      if (this._animating.has(r.id)) {
        const anim = this._animating.get(r.id);
        const { x, y } = this._project(r.lat, r.lng);
        const h = heightM != null
          ? heightM * METERS_TO_NDC
          : this._yearToHeight(r.year);
        anim.solidMesh.position.set(x, y, h / 2);
        anim.solidMesh.scale.set(w, w, h);
        anim.wireMesh.position.set(x, y, h / 2);
        anim.wireMesh.scale.set(w, w, h);
        anim.heightM = heightM;
        continue;  // do not add to InstancedMesh while animation is live
      }

      // ── Case 2: newly demolished this tick — spawn transition animation ─────
      if (ghost && this._prevStates.get(r.id) === false) {
        const THREE = this._THREE;
        const { x, y } = this._project(r.lat, r.lng);
        const h = heightM != null
          ? heightM * METERS_TO_NDC
          : this._yearToHeight(r.year);

        // Solid mesh: starts fully opaque, fades to 0 over ANIM_MS
        const solidMat  = this._materials[ei].solid.clone();
        solidMat.transparent = true;
        solidMat.opacity     = 1.0;
        const solidMesh = new THREE.Mesh(this._solidMeshes[ei].geometry, solidMat);
        solidMesh.position.set(x, y, h / 2);
        solidMesh.scale.set(w, w, h);
        this._scene.add(solidMesh);

        // Wireframe mesh: starts invisible, fades to 0.4 over ANIM_MS
        const wireMat  = this._materials[ei].wireframe.clone();
        wireMat.opacity = 0.0;
        const wireMesh = new THREE.Mesh(this._wireMeshes[ei].geometry, wireMat);
        wireMesh.position.set(x, y, h / 2);
        wireMesh.scale.set(w, w, h);
        wireMesh.renderOrder = 1;
        this._scene.add(wireMesh);

        this._animating.set(r.id, {
          startMs:  performance.now(),
          eraIdx:   ei,
          solidMesh,
          wireMesh,
          lat:      r.lat,
          lng:      r.lng,
          heightM,
          year:     r.year,
        });
        this._startAnimLoop();
        continue;  // not added to InstancedMesh while animating
      }

      // ── Case 3: steady state — write into era InstancedMesh ──────────────────
      if (!ghost && solidCounts[ei] >= MAX_INSTANCES) continue;
      if (ghost  && wireCounts[ei]  >= MAX_INSTANCES) continue;

      const { x, y } = this._project(r.lat, r.lng);
      const h = heightM != null
        ? heightM * METERS_TO_NDC
        : this._yearToHeight(r.year);

      this._dummy.position.set(x, y, h / 2);
      this._dummy.scale.set(w, w, h);
      this._dummy.rotation.set(0, 0, 0);
      this._dummy.updateMatrix();

      if (!ghost) {
        this._solidMeshes[ei].setMatrixAt(solidCounts[ei], this._dummy.matrix);
        instRecs[ei][solidCounts[ei]] = r;
        solidCounts[ei]++;
      } else {
        this._wireMeshes[ei].setMatrixAt(wireCounts[ei], this._dummy.matrix);
        instRecs[5 + ei][wireCounts[ei]] = r;
        wireCounts[ei]++;
      }
    }

    // Remove animations for buildings that left the scene entirely (e.g. panned out)
    for (const id of this._animating.keys()) {
      if (!newStates.has(id)) this._removeAnim(id);
    }

    // Commit counts and dirty flags for all 10 InstancedMesh objects
    for (let i = 0; i < 5; i++) {
      this._solidMeshes[i].count = solidCounts[i];
      this._wireMeshes[i].count  = wireCounts[i];
      this._solidMeshes[i].instanceMatrix.needsUpdate = true;
      this._wireMeshes[i].instanceMatrix.needsUpdate  = true;
    }

    // Publish the instance-to-record mapping for the next raycast
    this._instanceRecords = instRecs;

    // Keep the selection highlight mesh aligned after a pan/zoom re-project
    if (this._selectedRecord && this._highlightMesh) {
      const r    = this._selectedRecord;
      const bldg = this._buildings.find(b => b.record.id === r.id);
      if (bldg) {
        const { x, y } = this._project(r.lat, r.lng);
        const h = bldg.heightM != null
          ? bldg.heightM * METERS_TO_NDC
          : this._yearToHeight(r.year);
        const w2 = this._footprintWidth();
        this._highlightMesh.position.set(x, y, h / 2);
        this._highlightMesh.scale.set(w2 * 1.1, w2 * 1.1, h * 1.04);
      } else {
        // Selected building is no longer in the visible set — clear selection
        this._clearSelection();
        if (this._onSelect) this._onSelect(null);
      }
    }

    // Persist state snapshot for next call's transition detection
    this._prevStates = newStates;
  }

  /**
   * Remove an in-progress animation: detach individual Mesh objects from the
   * scene and release their cloned materials.
   */
  _removeAnim(id) {
    const anim = this._animating.get(id);
    if (!anim) return;
    this._scene.remove(anim.solidMesh);
    this._scene.remove(anim.wireMesh);
    anim.solidMesh.material.dispose();
    anim.wireMesh.material.dispose();
    this._animating.delete(id);
  }

  /** Start the rAF animation loop if it is not already running. */
  _startAnimLoop() {
    if (this._animLoopActive) return;
    this._animLoopActive = true;
    requestAnimationFrame(() => this._animTick());
  }

  /**
   * Per-frame tick that drives the solid → wireframe opacity transition.
   *
   * Each frame:
   *   • Interpolate solidMesh.opacity  from 1 → 0
   *   • Interpolate wireMesh.opacity   from 0 → 0.4
   *
   * When an animation completes, its individual Mesh objects are removed and
   * _rebuildMesh() is called so those buildings enter the wireframe InstancedMesh
   * pool for the next render.
   */
  _animTick() {
    if (!this._animating.size) {
      this._animLoopActive = false;
      return;
    }

    const now = performance.now();
    let needRebuild = false;

    for (const [id, anim] of this._animating) {
      const t = Math.min(1, (now - anim.startMs) / ANIM_MS);
      anim.solidMesh.material.opacity = 1 - t;
      anim.wireMesh.material.opacity  = 0.4 * t;

      if (t >= 1) {
        this._removeAnim(id);
        needRebuild = true;
      }
    }

    // After removing completed animations, rebuild so those buildings enter the
    // wireframe InstancedMesh pool (uses the already-stable _buildings list).
    if (needRebuild) this._rebuildMesh();

    this._renderFrame();

    if (this._animating.size > 0) {
      requestAnimationFrame(() => this._animTick());
    } else {
      this._animLoopActive = false;
    }
  }

  _renderFrame() {
    this._renderer.render(this._scene, this._camera);
  }

  // ── Leaflet event handlers ───────────────────────────────────────────────────

  /**
   * On moveend / zoomend: re-project stored buildings to the new viewport.
   * No need for the caller to re-call addBuilding — the list is stable between
   * slider/filter changes; only positions shift on pan/zoom.
   */
  _handleMove() {
    if (!this._ready) return;
    this._rebuildMesh();
    this._renderFrame();
  }

  /**
   * On Leaflet resize: update renderer resolution and camera aspect ratio
   * before redrawing so the canvas fills the new container dimensions.
   */
  _handleResize() {
    if (!this._ready) return;
    this._syncAspect();
    this._rebuildMesh();
    this._renderFrame();
  }
}
