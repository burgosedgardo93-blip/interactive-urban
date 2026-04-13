-- =============================================================================
-- 001_initial_schema.sql
-- Urban Layers — initial schema, RLS policies, and seed data
--
-- Run against a fresh Supabase project with:
--   supabase db push
-- or paste into the Supabase SQL editor.
--
-- Requires: pgcrypto (bundled with Supabase) for gen_random_uuid().
-- =============================================================================


-- =============================================================================
-- TABLES
-- =============================================================================

-- ---------------------------------------------------------------------------
-- records
-- Canonical, moderation-approved historical structures. Publicly readable
-- when verified = true.
-- ---------------------------------------------------------------------------
CREATE TABLE public.records (
  id             text              PRIMARY KEY,
  year           integer           NOT NULL
                                   CHECK (year BETWEEN 1000 AND 2100),
  title          text              NOT NULL,
  category       text              NOT NULL
                                   CHECK (category IN (
                                     'civic', 'commercial', 'residential',
                                     'infrastructure', 'entertainment', 'religious'
                                   )),
  description    text,
  lat            double precision  NOT NULL,
  lng            double precision  NOT NULL,
  architect      text,
  demolished     integer           CHECK (
                                     demolished IS NULL
                                     OR demolished BETWEEN 1000 AND 2100
                                   ),
  img_url        text,
  source         text              NOT NULL DEFAULT 'community',
  -- NULL for seeded/system records; uuid of the submitting auth.users row otherwise
  contributor_id uuid              REFERENCES auth.users(id) ON DELETE SET NULL,
  verified       boolean           NOT NULL DEFAULT false,
  created_at     timestamptz       NOT NULL DEFAULT now(),

  -- demolished must be after built year
  CONSTRAINT demolished_after_built CHECK (
    demolished IS NULL OR demolished >= year
  )
);

COMMENT ON TABLE  public.records                IS 'Canonical, admin-approved historical SF structures.';
COMMENT ON COLUMN public.records.demolished     IS 'Year the structure was demolished; NULL = still standing.';
COMMENT ON COLUMN public.records.verified       IS 'Only true records are visible to the public.';
COMMENT ON COLUMN public.records.contributor_id IS 'NULL for seed/LOC records; uuid for community submissions.';
COMMENT ON COLUMN public.records.source         IS 'Origin: seed | loc | dpla | community.';


-- ---------------------------------------------------------------------------
-- contributions
-- Unverified community submissions awaiting moderator review.
-- Same shape as records plus workflow columns.
-- Approved contributions are copied to records by an admin (or a trigger).
-- ---------------------------------------------------------------------------
CREATE TABLE public.contributions (
  id              text              PRIMARY KEY DEFAULT gen_random_uuid()::text,
  year            integer           NOT NULL
                                    CHECK (year BETWEEN 1000 AND 2100),
  title           text              NOT NULL,
  category        text              NOT NULL
                                    CHECK (category IN (
                                      'civic', 'commercial', 'residential',
                                      'infrastructure', 'entertainment', 'religious'
                                    )),
  description     text,
  lat             double precision  NOT NULL,
  lng             double precision  NOT NULL,
  architect       text,
  demolished      integer           CHECK (
                                      demolished IS NULL
                                      OR demolished BETWEEN 1000 AND 2100
                                    ),
  img_url         text,
  source          text              NOT NULL DEFAULT 'community',
  contributor_id  uuid              NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  verified        boolean           NOT NULL DEFAULT false,
  -- Moderation workflow
  status          text              NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'approved', 'rejected')),
  moderator_notes text,
  created_at      timestamptz       NOT NULL DEFAULT now(),

  CONSTRAINT contributions_demolished_after_built CHECK (
    demolished IS NULL OR demolished >= year
  )
);

COMMENT ON TABLE  public.contributions                  IS 'Unverified community submissions; promoted to records on approval.';
COMMENT ON COLUMN public.contributions.status           IS 'pending → under review | approved → copied to records | rejected → denied.';
COMMENT ON COLUMN public.contributions.moderator_notes  IS 'Admin-only notes explaining approval or rejection rationale.';


-- =============================================================================
-- INDEXES
-- =============================================================================

-- Primary read path: verified records within a bounding box
CREATE INDEX idx_records_bbox
  ON public.records (lat, lng)
  WHERE verified = true;

-- Year filter on the verified read path
CREATE INDEX idx_records_year
  ON public.records (year)
  WHERE verified = true;

-- Moderation queue
CREATE INDEX idx_contributions_status_created
  ON public.contributions (status, created_at);

-- Contributor's own submissions
CREATE INDEX idx_contributions_contributor
  ON public.contributions (contributor_id, created_at DESC);


-- =============================================================================
-- ROW-LEVEL SECURITY
-- =============================================================================

ALTER TABLE public.records       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contributions ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Helper: is the calling JWT from an admin user?
--
-- Admins are identified by  app_metadata.role = 'admin'  in their JWT.
-- app_metadata is only writable via the Supabase service-role key or the
-- Auth admin API, so users cannot elevate themselves.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin',
    false
  )
$$;

COMMENT ON FUNCTION public.is_admin() IS
  'Returns true when the calling JWT carries app_metadata.role = ''admin''.';


-- ── records policies ──────────────────────────────────────────────────────

-- (1) Anyone (anon or authenticated) can read verified records.
CREATE POLICY "records: public read verified"
  ON public.records
  FOR SELECT
  USING (verified = true);

-- (2) Admins have full write access.
--     This covers: seed ingestion via service role, promoting a contribution,
--     toggling verified, and correcting data.
CREATE POLICY "records: admin full access"
  ON public.records
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());


-- ── contributions policies ────────────────────────────────────────────────

-- (3) Authenticated users may insert their own contributions.
--     The WITH CHECK prevents impersonating another contributor_id.
CREATE POLICY "contributions: authenticated insert own"
  ON public.contributions
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = contributor_id);

-- (4) Contributors can read their own submissions; admins can read all.
CREATE POLICY "contributions: read own or admin"
  ON public.contributions
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = contributor_id
    OR public.is_admin()
  );

-- (5) Only admins may update contributions (to set status / moderator_notes).
CREATE POLICY "contributions: admin update"
  ON public.contributions
  FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- (6) Only admins may hard-delete contributions.
CREATE POLICY "contributions: admin delete"
  ON public.contributions
  FOR DELETE
  USING (public.is_admin());


-- =============================================================================
-- SEED DATA
-- The 12 canonical SF records from BASE_RECORDS in index.html.
-- All are verified = true so they are immediately public.
-- contributor_id is NULL because these are system-seeded, not user-submitted.
-- IDs match the frontend BASE_RECORDS ids (sf-001 … sf-012) for traceability.
-- =============================================================================

INSERT INTO public.records
  (id, year, title, category, description,
   lat, lng, architect, demolished, img_url, source, contributor_id, verified)
VALUES

  ('sf-001', 1898,
   'Ferry Building',
   'civic',
   'Beaux-Arts transit hub and marketplace at the foot of Market Street. Its 245-foot clock tower survived the 1906 earthquake nearly intact, becoming a symbol of the city''s resilience.',
   37.7955, -122.3937,
   'A. Page Brown', NULL, NULL, 'seed', NULL, true),

  ('sf-002', 1915,
   'San Francisco City Hall',
   'civic',
   'Rebuilt after the 1906 earthquake, this Beaux-Arts masterpiece features a dome taller than the U.S. Capitol. Designed to project civic confidence after the disaster.',
   37.7793, -122.4193,
   'Arthur Brown Jr.', NULL, NULL, 'seed', NULL, true),

  ('sf-003', 1972,
   'Transamerica Pyramid',
   'commercial',
   'Postmodern skyscraper that became the most recognizable feature of the SF skyline. Controversial at its 1972 opening, it is now a protected landmark.',
   37.7952, -122.4028,
   'William Pereira', NULL, NULL, 'seed', NULL, true),

  ('sf-004', 1896,
   'Sutro Baths',
   'entertainment',
   'The world''s largest indoor swimming complex in its day, holding over 1.6 million gallons in six saltwater pools. A marvel of Victorian engineering, destroyed by fire in 1966.',
   37.7799, -122.5133,
   'Adolph Sutro', 1966, NULL, 'seed', NULL, true),

  ('sf-005', 1886,
   'Haas-Lilienthal House',
   'residential',
   'One of the few intact Victorian-era mansions in San Francisco. This Queen Anne–style home survived the 1906 earthquake and fire and is now a house museum.',
   37.7875, -122.4327,
   'Peter R. Schmidt', NULL, NULL, 'seed', NULL, true),

  ('sf-006', 1959,
   'Embarcadero Freeway',
   'infrastructure',
   'Double-deck elevated freeway that bisected downtown from the waterfront. Long contested by preservationists, it was demolished after sustaining damage in the 1989 Loma Prieta earthquake.',
   37.7956, -122.3975,
   NULL, 1991, NULL, 'seed', NULL, true),

  ('sf-007', 1915,
   'Palace of Fine Arts',
   'civic',
   'Designed for the 1915 Panama-Pacific International Exposition, this beloved Roman-classical rotunda was preserved permanently. The current concrete structure is a 1960s reconstruction.',
   37.8029, -122.4484,
   'Bernard Maybeck', NULL, NULL, 'seed', NULL, true),

  ('sf-008', 1913,
   'Spreckels Mansion',
   'residential',
   'Lavish Beaux-Arts palace built for sugar heiress Alma de Bretteville Spreckels, inspired by the Palace of Versailles. Now a private residence, owned for many years by author Danielle Steel.',
   37.7921, -122.4444,
   'George Applegarth', NULL, NULL, 'seed', NULL, true),

  ('sf-009', 1933,
   'Coit Tower',
   'civic',
   'Art Deco tower atop Telegraph Hill, built with funds bequeathed by Lillie Hitchcock Coit to beautify the city. Its interior New Deal murals depicting labor and society remain controversial.',
   37.8024, -122.4058,
   'Arthur Brown Jr.', NULL, NULL, 'seed', NULL, true),

  ('sf-010', 1791,
   'Mission Dolores',
   'religious',
   'Oldest intact building in San Francisco, founded as Mission San Francisco de Asís. The adobe walls have withstood every earthquake since the Spanish colonial period.',
   37.7652, -122.4270,
   NULL, NULL, NULL, 'seed', NULL, true),

  ('sf-011', 1909,
   'Cliff House',
   'entertainment',
   'Third iteration of a Victorian pleasure resort perched on the cliffs above Ocean Beach. The current Adirondack-style building replaced a grand château that burned in 1907.',
   37.7786, -122.5134,
   'Reid Brothers', NULL, NULL, 'seed', NULL, true),

  ('sf-012', 1866,
   'Woodward''s Gardens',
   'entertainment',
   'San Francisco''s first great amusement park, covering two city blocks between Mission and Valencia. Featured a zoo, aquarium, art gallery, and amphitheater before closing in 1891.',
   37.7677, -122.4181,
   NULL, 1894, NULL, 'seed', NULL, true);
