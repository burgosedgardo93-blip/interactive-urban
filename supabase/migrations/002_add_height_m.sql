-- =============================================================================
-- 002_add_height_m.sql
-- Urban Layers — add height_m to records and contributions
--
-- height_m stores the building's height in metres as resolved by
-- buildingHeightResolver.js (Supabase field → Overpass OSM → category heuristic).
-- NULL means "not yet resolved"; the resolver fills it at runtime and may
-- eventually be used to back-fill this column via a scheduled job.
--
-- Run with:
--   supabase db push
-- or paste into the Supabase SQL editor.
-- =============================================================================

-- ── records ──────────────────────────────────────────────────────────────────

ALTER TABLE public.records
  ADD COLUMN IF NOT EXISTS height_m double precision
    CONSTRAINT records_height_m_positive
      CHECK (height_m IS NULL OR height_m > 0);

COMMENT ON COLUMN public.records.height_m IS
  'Building height in metres. NULL = not yet resolved. '
  'Priority for the resolver: this field → Overpass API (OSM height / '
  'building:levels × 3.5 m) → category heuristic.';

-- ── contributions ─────────────────────────────────────────────────────────────
-- Community submitters may optionally include a known height.
-- The resolver fills the gap if absent.

ALTER TABLE public.contributions
  ADD COLUMN IF NOT EXISTS height_m double precision
    CONSTRAINT contributions_height_m_positive
      CHECK (height_m IS NULL OR height_m > 0);

COMMENT ON COLUMN public.contributions.height_m IS
  'Submitter-provided building height in metres. Optional; resolver fills gaps.';

-- ── Back-fill index hint ───────────────────────────────────────────────────────
-- Useful for a future job that selects un-resolved verified records.
CREATE INDEX IF NOT EXISTS idx_records_height_null
  ON public.records (id)
  WHERE verified = true AND height_m IS NULL;
