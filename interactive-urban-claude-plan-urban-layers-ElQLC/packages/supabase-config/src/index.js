import { createClient } from "@supabase/supabase-js";

const RECORD_COLUMNS =
  "id, year, title, category, description, lat, lng, architect, demolished, img_url, source";

let _client = null;

function readEnv(name) {
  if (typeof process !== "undefined" && process.env?.[name]) return process.env[name];
  if (typeof process !== "undefined" && process.env?.[`EXPO_PUBLIC_${name}`]) {
    return process.env[`EXPO_PUBLIC_${name}`];
  }
  return undefined;
}

export function getSupabaseClient() {
  if (_client) return _client;
  const url = readEnv("SUPABASE_URL");
  const anonKey = readEnv("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    throw new Error(
      "[supabase-config] SUPABASE_URL and SUPABASE_ANON_KEY must be set."
    );
  }
  _client = createClient(url, anonKey);
  return _client;
}

export async function fetchRecordsByBBox(bounds, yearRange) {
  const { north, south, east, west } = bounds;
  const { from, to } = yearRange;
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("records")
    .select(RECORD_COLUMNS)
    .eq("verified", true)
    .gte("lat", south)
    .lte("lat", north)
    .gte("lng", west)
    .lte("lng", east)
    .lte("year", to)
    .or(`demolished.is.null,demolished.gte.${from}`)
    .order("year", { ascending: true });

  if (error) throw new Error(`fetchRecordsByBBox: ${error.message}`);
  return (data ?? []).map(normalizeRecord);
}

export async function submitContribution(record) {
  const supabase = getSupabaseClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new Error("submitContribution: must be signed in to submit a contribution.");
  }

  const payload = {
    year: record.year,
    title: record.title,
    category: record.category,
    description: record.description ?? null,
    lat: record.lat,
    lng: record.lng,
    architect: record.architect ?? null,
    demolished: record.demolished ?? null,
    img_url: record.img_url ?? null,
    source: "community",
    contributor_id: user.id,
    status: "pending",
    verified: false,
  };

  const { data, error } = await supabase
    .from("contributions")
    .insert(payload)
    .select("id, status, created_at")
    .single();

  if (error) throw new Error(`submitContribution: ${error.message}`);
  return data;
}

export async function fetchPendingContributions() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("contributions")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) throw new Error(`fetchPendingContributions: ${error.message}`);
  return data ?? [];
}

function normalizeRecord(row) {
  return {
    id: row.id,
    year: row.year,
    title: row.title,
    category: row.category,
    desc: row.description ?? "",
    lat: row.lat,
    lng: row.lng,
    architect: row.architect ?? null,
    demolished: row.demolished ?? null,
    img: row.img_url ?? null,
    source: row.source,
  };
}
