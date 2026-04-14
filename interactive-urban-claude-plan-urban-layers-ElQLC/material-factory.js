/**
 * material-factory.js
 * Urban Layers — Three.js material assignments based on building construction era.
 *
 * Five historical eras, each with a distinct material reflecting the construction
 * technology of the period:
 *
 *   Pre-1890   : warm sandstone  (#c8a87a) — MeshPhongMaterial, low shininess
 *   1890–1920  : red brick       (#8b4a3a) — MeshStandardMaterial, medium roughness
 *   1920–1945  : concrete grey   (#9a9a8e) — MeshLambertMaterial, flat diffuse
 *   1945–1965  : glass / steel   (#6a8fa0) — MeshStandardMaterial, metalness 0.4
 *   Post-1965  : modern white    (#e8e4dc) — MeshStandardMaterial, smooth
 *
 * Usage:
 *   import { eraIndex, createMaterials } from './material-factory.js';
 *
 *   const mats = createMaterials(THREE);   // call once after Three.js is ready
 *   const i    = eraIndex(record.year);    // 0–4
 *   // Standing building:  mats[i].solid
 *   // Demolished ghost:   mats[i].wireframe   (transparent, opacity 0.4)
 */

// ── Era colour palette ─────────────────────────────────────────────────────────

/** Hex colour string for each era, indexed 0–4. */
export const ERA_COLORS = [
  '#c8a87a',  // 0  pre-1890   warm sandstone
  '#8b4a3a',  // 1  1890-1920  red brick
  '#9a9a8e',  // 2  1920-1945  concrete grey
  '#6a8fa0',  // 3  1945-1965  glass / steel
  '#e8e4dc',  // 4  post-1965  modern white
];

// Inclusive upper construction year for eras 0-3; era 4 = everything later.
const ERA_BREAKS = [1889, 1920, 1945, 1965];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Map a construction year to an era index 0–4.
 *
 * @param {number} year  Construction year of the building.
 * @returns {0|1|2|3|4}
 */
export function eraIndex(year) {
  for (let i = 0; i < ERA_BREAKS.length; i++) {
    if (year <= ERA_BREAKS[i]) return i;
  }
  return 4;
}

/**
 * Instantiate all 10 Three.js materials (solid + wireframe for each of 5 eras).
 *
 * Each returned material is a fresh instance — callers may clone or adjust
 * per-mesh opacity without affecting other meshes.  Wireframe variants are
 * pre-configured with `transparent: true` and `opacity: 0.4`.
 *
 * @param {object} THREE  The Three.js module (dynamically imported from CDN).
 * @returns {Array<{ solid: THREE.Material, wireframe: THREE.Material }>}
 *   Five-element array, indices matching eraIndex() output.
 */
export function createMaterials(THREE) {
  const c = (hex) => parseInt(hex.replace('#', ''), 16);

  return [
    // ── 0: pre-1890 — warm sandstone, MeshPhongMaterial, very low shininess ──
    {
      solid: new THREE.MeshPhongMaterial({
        color:     c(ERA_COLORS[0]),
        shininess: 8,
        specular:  0x221100,
      }),
      wireframe: new THREE.MeshPhongMaterial({
        color:       c(ERA_COLORS[0]),
        wireframe:   true,
        transparent: true,
        opacity:     0.4,
      }),
    },

    // ── 1: 1890-1920 — red brick, MeshStandardMaterial, medium roughness ─────
    {
      solid: new THREE.MeshStandardMaterial({
        color:     c(ERA_COLORS[1]),
        roughness: 0.72,
        metalness: 0.0,
      }),
      wireframe: new THREE.MeshStandardMaterial({
        color:       c(ERA_COLORS[1]),
        wireframe:   true,
        transparent: true,
        opacity:     0.4,
        roughness:   0.72,
        metalness:   0.0,
      }),
    },

    // ── 2: 1920-1945 — concrete grey, MeshLambertMaterial, flat diffuse ──────
    {
      solid: new THREE.MeshLambertMaterial({
        color: c(ERA_COLORS[2]),
      }),
      wireframe: new THREE.MeshLambertMaterial({
        color:       c(ERA_COLORS[2]),
        wireframe:   true,
        transparent: true,
        opacity:     0.4,
      }),
    },

    // ── 3: 1945-1965 — glass/steel, MeshStandardMaterial, metalness 0.4 ──────
    {
      solid: new THREE.MeshStandardMaterial({
        color:     c(ERA_COLORS[3]),
        roughness: 0.12,
        metalness: 0.4,
      }),
      wireframe: new THREE.MeshStandardMaterial({
        color:       c(ERA_COLORS[3]),
        wireframe:   true,
        transparent: true,
        opacity:     0.4,
        roughness:   0.12,
        metalness:   0.4,
      }),
    },

    // ── 4: post-1965 — modern white, MeshStandardMaterial, smooth ─────────────
    {
      solid: new THREE.MeshStandardMaterial({
        color:     c(ERA_COLORS[4]),
        roughness: 0.22,
        metalness: 0.0,
      }),
      wireframe: new THREE.MeshStandardMaterial({
        color:       c(ERA_COLORS[4]),
        wireframe:   true,
        transparent: true,
        opacity:     0.4,
        roughness:   0.22,
        metalness:   0.0,
      }),
    },
  ];
}
