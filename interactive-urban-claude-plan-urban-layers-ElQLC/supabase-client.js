/**
 * supabase-client.js
 * Urban Layers — Supabase data-access module
 *
 * Install:  npm install @supabase/supabase-js
 *
 * Environment variables (set before importing):
 *   SUPABASE_URL       — project URL  (https://<ref>.supabase.co)
 *   SUPABASE_ANON_KEY  — anon/public key  (safe to expose in browser)
 *
 * With Vite use VITE_ prefixed names and import.meta.env will be tried
 * as the fallback automatically.
 *
 * Admin-only functions (fetchPendingContributions) rely on Supabase RLS:
 * they return only the caller's own rows for regular users, and all rows
 * for users whose JWT carries  app_metadata.role = "admin".
 */

import { createClient } from "@supabase/supabase-js";

// ── Client singleton ──────────────────────────────────────────────────────────

const SUPABASE_URL = (
  typeof process !== "undefined" ? process.env.SUPABASE_URL : undefined
) ?? (
  typeof import.meta !== "undefined" ? import.meta.env?.VITE_SUPABASE_URL : undefined
);

const SUPABASE_ANON_KEY = (
  typeof process !== "undefined" ? process.env.SUPABASE_ANON_KEY : undefined
) ?? (
  typeof import.meta !== "undefined" ? import.meta.env?.VITE_SUPABASE_ANON_KEY : undefined
);

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "[supabase-client] SUPABASE_URL and SUPABASE_ANON_KEY must be set. " +
    "Copy .env.example → .env and fill in your project credentials."
  );
}

/**
 * Shared Supabase client. Export it so callers can use auth helpers
 * (supabase.auth.signIn, supabase.auth.getUser, etc.) without creating
 * a second instance.
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Column list for public record queries ─────────────────────────────────────
// Excludes contributor_id (internal) and verified (always true on this path).
const RECORD_COLUMNS =
  "id, year, title, category, description, lat, lng, architect, demolished, img_url, source";


// =============================================================================
// fetchRecordsByBBox
// =============================================================================

/**
 * Returns all verified records whose coordinates fall within `bounds` AND
 * which were in existence at some point during `yearRange`.
 *
 * "In existence during [from, to]" means:
 *   year       <= to          — built by the end of the window
 *   demolished  IS NULL
 *     OR demolished >= from   — not yet gone at the start of the window
 *
 * The returned objects are normalised to the frontend data model so they
 * can be fed directly into getMarkerState() and the Leaflet render loop.
 *
 * @param {{ north: number, south: number, east: number, west: number }} bounds
 *   Bounding box in WGS-84 decimal degrees.
 *   Note: longitude wrapping across the antimeridian is not handled here;
 *   for SF-focused use this is not a concern.
 *
 * @param {{ from: number, to: number }} yearRange
 *   Inclusive year range. Typical call: { from: viewYear - 10, to: viewYear + 10 }.
 *
 * @returns {Promise<Array<{
 *   id: string, year: number, title: string, category: string,
 *   desc: string, lat: number, lng: number, architect: string|null,
 *   demolished: number|null, img: string|null, source: string
 * }>>}
 */
export async function fetchRecordsByBBox(bounds, yearRange) {
  const { north, south, east, west } = bounds;
  const { from, to } = yearRange;

  const { data, error } = await supabase
    .from("records")
    .select(RECORD_COLUMNS)
    .eq("verified", true)
    // ── Bounding box ──────────────────────────────────────────────────────
    .gte("lat", south)
    .lte("lat", north)
    .gte("lng", west)
    .lte("lng", east)
    // ── Temporal window ───────────────────────────────────────────────────
    // Built by end of window
    .lte("year", to)
    // Not demolished before start of window
    // PostgREST OR syntax: "col.op.val,col.op.val"
    .or(`demolished.is.null,demolished.gte.${from}`)
    .order("year", { ascending: true });

  if (error) throw new Error(`fetchRecordsByBBox: ${error.message}`);

  return (data ?? []).map(normalizeRecord);
}


// =============================================================================
// submitContribution
// =============================================================================

/**
 * Submits a new community contribution for moderator review.
 *
 * Requirements:
 *   • The caller must be signed in (supabase.auth.signInWith…).
 *   • contributor_id is taken from the active session — callers cannot spoof it.
 *   • The RLS policy additionally enforces auth.uid() = contributor_id server-side.
 *
 * @param {{
 *   year: number,
 *   title: string,
 *   category: 'civic'|'commercial'|'residential'|'infrastructure'|'entertainment'|'religious',
 *   description?: string,
 *   lat: number,
 *   lng: number,
 *   architect?: string,
 *   demolished?: number|null,
 *   img_url?: string,
 * }} record
 *   Do NOT include id, contributor_id, status, verified, or created_at —
 *   those are set here or enforced by the database.
 *
 * @returns {Promise<{ id: string, status: 'pending', created_at: string }>}
 */
export async function submitContribution(record) {
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    throw new Error(
      "submitContribution: must be signed in to submit a contribution."
    );
  }

  // Whitelist the caller-provided fields explicitly.
  // Never forward contributor_id, status, verified, or created_at from the
  // caller — each is either locked to the session or set by the DB.
  const payload = {
    year:           record.year,
    title:          record.title,
    category:       record.category,
    description:    record.description ?? null,
    lat:            record.lat,
    lng:            record.lng,
    architect:      record.architect   ?? null,
    demolished:     record.demolished  ?? null,
    img_url:        record.img_url     ?? null,
    source:         "community",
    contributor_id: user.id,   // authoritative: from the verified session
    status:         "pending",
    verified:       false,
  };

  const { data, error } = await supabase
    .from("contributions")
    .insert(payload)
    .select("id, status, created_at")
    .single();

  if (error) throw new Error(`submitContribution: ${error.message}`);
  return data;
}


// =============================================================================
// fetchPendingContributions
// =============================================================================

/**
 * Returns contributions with status = 'pending', ordered oldest-first.
 *
 * Access is governed by RLS:
 *   • Admin  (app_metadata.role = 'admin') → all pending rows
 *   • Regular authenticated user           → only their own pending rows
 *   • Unauthenticated                      → empty array
 *
 * Call this from an admin dashboard or a server-side context; do not
 * expose raw contribution data to regular users.
 *
 * @returns {Promise<Array>} Raw contribution rows including moderator_notes.
 */
export async function fetchPendingContributions() {
  const { data, error } = await supabase
    .from("contributions")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) throw new Error(`fetchPendingContributions: ${error.message}`);
  return data ?? [];
}


// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Translates a database row into the frontend data model consumed by
 * getMarkerState() and the Leaflet render loop.
 *
 * DB column  →  frontend field
 * description  →  desc
 * img_url      →  img
 *
 * @param {Object} row — raw Supabase response row
 * @returns {Object}
 */
function normalizeRecord(row) {
  return {
    id:         row.id,
    year:       row.year,
    title:      row.title,
    category:   row.category,
    desc:       row.description ?? "",
    lat:        row.lat,
    lng:        row.lng,
    architect:  row.architect  ?? null,
    demolished: row.demolished ?? null,
    img:        row.img_url    ?? null,
    source:     row.source,
  };
}
