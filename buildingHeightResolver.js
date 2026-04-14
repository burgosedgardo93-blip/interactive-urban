/**
 * buildingHeightResolver.js
 * Urban Layers — resolve real building heights (metres) for a batch of records.
 *
 * Priority chain per record:
 *   1. record.height_m  — value already stored in Supabase (fastest, no network)
 *   2. Overpass API     — single bbox query for all un-resolved records; matches
 *                         nearest OSM building within 75 m; parses `height` tag
 *                         or derives from `building:levels` × 3.5 m.
 *   3. Category heuristic — deterministic fallback when OSM has no building data.
 *
 * Usage:
 *   import { resolveHeights } from './buildingHeightResolver.js';
 *
 *   // returns Map<recordId, heightMetres>
 *   const heights = await resolveHeights(records, { signal: abortController.signal });
 *
 * Design notes:
 * • All network I/O flows through the caller-supplied AbortSignal so the caller
 *   can cancel cleanly (e.g. when a newer fetch generation starts).
 * • The Overpass query is a single POST for the bounding box of all unresolved
 *   records, not one request per record.  One round trip regardless of count.
 * • OSM building matching uses haversine distance; only buildings within
 *   MATCH_RADIUS_M metres of a record's lat/lng are considered.
 * • This module has zero runtime dependencies beyond the browser Fetch API.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const OVERPASS_URL    = "https://overpass-api.de/api/interpreter";
const MATCH_RADIUS_M  = 75;      // max metres between record & OSM building centre
const LEVELS_TO_M     = 3.5;     // metres per storey (CTBUH standard)
const TIMEOUT_S       = 25;      // Overpass server-side timeout (seconds)

/** Median floor-to-floor height assumptions per category (metres). */
const HEURISTIC_M = {
  civic:          20,
  commercial:     35,
  residential:     8,
  infrastructure: 12,
  entertainment:  15,
  religious:      10,
};

const DEFAULT_HEURISTIC_M = 10;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve heights for an array of records.
 *
 * @param {Array<{id: string, lat: number, lng: number, category: string, height_m?: number|null}>} records
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Map<string, number>>}  Map of record.id → resolved height in metres.
 */
export async function resolveHeights(records, { signal } = {}) {
  const result = new Map();

  // ── Step 1: Use Supabase-stored height_m when present ────────────────────
  const unresolved = [];
  for (const r of records) {
    if (r.height_m != null && r.height_m > 0) {
      result.set(r.id, r.height_m);
    } else {
      unresolved.push(r);
    }
  }

  if (unresolved.length === 0) return result;

  // ── Step 2: Overpass API batch query ─────────────────────────────────────
  let osmHeights = new Map(); // record.id → metres from OSM
  try {
    osmHeights = await _queryOverpass(unresolved, signal);
  } catch (err) {
    // Overpass is optional — network errors or abort fall through to heuristic.
    if (err.name === "AbortError") throw err;  // propagate cancellation
    console.warn("[buildingHeightResolver] Overpass query failed:", err.message);
  }

  // ── Step 3: Merge OSM results; apply heuristic for anything still missing ─
  for (const r of unresolved) {
    if (osmHeights.has(r.id)) {
      result.set(r.id, osmHeights.get(r.id));
    } else {
      result.set(r.id, _heuristic(r.category));
    }
  }

  return result;
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * POST a single Overpass QL query covering the bounding box of all `records`.
 * Returns a Map<recordId, metres> for every record whose nearest OSM building
 * centre falls within MATCH_RADIUS_M metres.
 *
 * @param {Array} records  Non-empty array of unresolved records.
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<Map<string, number>>}
 */
async function _queryOverpass(records, signal) {
  const bbox = _boundingBox(records);

  // Overpass QL: fetch all building ways/relations in the bbox, output
  // centre lat/lng and relevant tags only.
  const query = `
[out:json][timeout:${TIMEOUT_S}];
(
  way["building"](${bbox.s},${bbox.w},${bbox.n},${bbox.e});
  relation["building"](${bbox.s},${bbox.w},${bbox.n},${bbox.e});
);
out center tags;
`.trim();

  const resp = await fetch(OVERPASS_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    `data=${encodeURIComponent(query)}`,
    signal,
  });

  if (!resp.ok) {
    throw new Error(`Overpass HTTP ${resp.status}`);
  }

  const json = await resp.json();
  const elements = json.elements ?? [];

  // Build a flat list of OSM building centres with extracted heights.
  const osmBuildings = [];
  for (const el of elements) {
    const centre = el.center ?? (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
    if (!centre) continue;
    const h = _extractHeight(el.tags ?? {});
    if (h == null) continue;
    osmBuildings.push({ lat: centre.lat, lng: centre.lon, h });
  }

  // For each record, find the closest OSM building within MATCH_RADIUS_M.
  const result = new Map();
  for (const r of records) {
    let bestH   = null;
    let bestDist = Infinity;
    for (const b of osmBuildings) {
      const d = _haversineM(r.lat, r.lng, b.lat, b.lng);
      if (d < bestDist && d <= MATCH_RADIUS_M) {
        bestDist = d;
        bestH    = b.h;
      }
    }
    if (bestH != null) result.set(r.id, bestH);
  }

  return result;
}

/**
 * Extract a building height in metres from OSM tags.
 * Returns null when no usable tag is found.
 *
 * Tag priority:
 *   1. `height`           — e.g. "45", "45 m", "45.5"
 *   2. `building:levels`  — integer storey count × LEVELS_TO_M
 *   3. `building:height`  — same parsing as `height`
 *
 * @param {object} tags  OSM element tags object.
 * @returns {number|null}
 */
function _extractHeight(tags) {
  // Helper: parse "45", "45 m", "45.5 ft" → metres
  const parseMetres = (str) => {
    if (!str) return null;
    const m = str.match(/^([\d.]+)\s*(ft|feet)?/i);
    if (!m) return null;
    const v = parseFloat(m[1]);
    if (!isFinite(v) || v <= 0) return null;
    return m[2] ? v * 0.3048 : v;  // convert feet if unit present
  };

  const h = parseMetres(tags["height"]);
  if (h != null) return h;

  const levels = parseInt(tags["building:levels"], 10);
  if (isFinite(levels) && levels > 0) return levels * LEVELS_TO_M;

  const bh = parseMetres(tags["building:height"]);
  if (bh != null) return bh;

  return null;
}

/**
 * Return the bounding box (south, west, north, east) for a set of records,
 * padded by ~0.001° (~111 m) on each side so buildings at the edge of the
 * set are still captured.
 *
 * @param {Array<{lat: number, lng: number}>} records
 * @returns {{ s: number, w: number, n: number, e: number }}
 */
function _boundingBox(records) {
  let s =  Infinity, w =  Infinity;
  let n = -Infinity, e = -Infinity;
  for (const r of records) {
    if (r.lat < s) s = r.lat;
    if (r.lat > n) n = r.lat;
    if (r.lng < w) w = r.lng;
    if (r.lng > e) e = r.lng;
  }
  const pad = 0.001;
  return { s: s - pad, w: w - pad, n: n + pad, e: e + pad };
}

/**
 * Haversine great-circle distance in metres between two WGS-84 points.
 *
 * @param {number} lat1  Decimal degrees
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number}  Metres
 */
function _haversineM(lat1, lng1, lat2, lng2) {
  const R  = 6_371_000;  // Earth radius, metres
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a  = Math.sin(Δφ / 2) ** 2 +
             Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Category heuristic fallback.
 *
 * @param {string} category
 * @returns {number}  Metres
 */
function _heuristic(category) {
  return HEURISTIC_M[category] ?? DEFAULT_HEURISTIC_M;
}
