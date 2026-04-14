#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");

const LOC_BASE = "https://www.loc.gov/photos/";
const DPLA_BASE = "https://api.dp.la/v2/items";
const DPLA_API_KEY = process.env.DPLA_API_KEY || "";

const CITY_CONFIG = {
  "san francisco": {
    slug: "san-francisco",
    display: "San Francisco",
    state: "California",
    centroid: { lat: 37.7749, lng: -122.4194 },
    bbox: "37.9298,-122.5153:37.6968,-122.3570",
  },
  chicago: {
    slug: "chicago",
    display: "Chicago",
    state: "Illinois",
    centroid: { lat: 41.8781, lng: -87.6298 },
    bbox: "42.0230,-87.9401:41.6445,-87.5237",
  },
  "new york": {
    slug: "new-york",
    display: "New York",
    state: "New York",
    centroid: { lat: 40.7128, lng: -74.006 },
    bbox: "40.9176,-74.2591:40.4774,-73.7004",
  },
};

function parseArg(name, fallback = "") {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1).trim();
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1].trim();
  return fallback;
}

function firstString(value) {
  if (Array.isArray(value)) return value.find((v) => typeof v === "string") || "";
  if (typeof value === "string") return value;
  return "";
}

function parseYear(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const text = firstString(value);
  const m = text.match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  return m ? Number(m[1]) : null;
}

function normalizeCategory(textBits) {
  const hay = textBits.join(" ").toLowerCase();
  if (/church|cathedral|synagogue|temple|mission/.test(hay)) return "religious";
  if (/bridge|freeway|rail|station|terminal|harbor|port|pier|road|street|transit/.test(hay)) return "infrastructure";
  if (/theater|theatre|park|bath|amusement|stadium|club|cinema|music|fair/.test(hay)) return "entertainment";
  if (/house|home|residential|apartment|tenement|mansion|villa/.test(hay)) return "residential";
  if (/city hall|court|school|library|hospital|post office|municipal|civic|government/.test(hay)) return "civic";
  if (/store|office|factory|warehouse|hotel|bank|commercial|market|building/.test(hay)) return "commercial";
  return "civic";
}

function safeId(prefix, rawId) {
  return `${prefix}-${String(rawId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}`;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "urban-layers-ingest/1.0" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} for ${url}\n${body.slice(0, 200)}`);
  }
  return res.json();
}

function mapLocRecord(item, city) {
  const idFromUrl = String(item.url || "").match(/\/item\/([^/]+)\//)?.[1] || item.id || item.pk || Math.random().toString(36).slice(2);
  const subjects = Array.isArray(item.subject) ? item.subject : [];
  const originalFormat = Array.isArray(item.original_format) ? item.original_format : [];
  const category = normalizeCategory([item.title || "", ...subjects, ...originalFormat]);
  const year = parseYear(item.date);
  const title = firstString(item.title).replace(/\/+$/, "").trim();
  const desc = firstString(item.description).trim();
  const architect = firstString(item.contributor).trim() || null;
  const img = item?.resources?.[0]?.medium || item?.resources?.[0]?.small || null;

  return {
    id: safeId("loc", idFromUrl),
    year,
    title: title || `Untitled LOC ${idFromUrl}`,
    category,
    description: desc || null,
    lat: city.centroid.lat,
    lng: city.centroid.lng,
    architect,
    demolished: null,
    img_url: img,
    source: "loc",
    city: city.display,
    verified: true,
  };
}

function parseCoordinates(value) {
  const raw = firstString(value);
  const parts = raw.split(",").map((n) => Number(n.trim()));
  if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) return null;
  return { lat: parts[0], lng: parts[1] };
}

function mapDplaRecord(doc, city) {
  const source = doc.sourceResource || {};
  const title = firstString(source.title).trim() || "Untitled DPLA";
  const desc = firstString(source.description).trim();
  const date = source.date || {};
  const year = parseYear(date.begin) || parseYear(date.displayDate) || parseYear(source.date);
  const creator = firstString(source.creator).trim() || null;
  const fmt = firstString(source.format);
  const typ = firstString(source.type);
  const subjectNames = (Array.isArray(source.subject) ? source.subject : [])
    .map((s) => (typeof s?.name === "string" ? s.name : ""))
    .filter(Boolean);
  const category = normalizeCategory([title, fmt, typ, ...subjectNames]);
  const spatial = Array.isArray(source.spatial) ? source.spatial : [];
  const coordsRaw = spatial.map((s) => s?.coordinates).find(Boolean);
  const coords = parseCoordinates(coordsRaw) || city.centroid;
  const img = doc.isShownBy || doc?.object?.["@id"] || null;
  const idCore = doc._id || doc.id || Math.random().toString(36).slice(2);

  return {
    id: safeId("dpla", idCore),
    year,
    title,
    category,
    description: desc || null,
    lat: coords.lat,
    lng: coords.lng,
    architect: creator,
    demolished: null,
    img_url: img,
    source: "dpla",
    city: city.display,
    verified: true,
  };
}

function dedupeRecords(records) {
  const out = [];
  const seen = new Set();
  for (const r of records) {
    const key = r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function fetchLoc(city, target) {
  const rows = [];
  const pageSize = 100;
  const cityFacet = city.display.toLowerCase().replace(/\s+/g, "+");
  const queries = [
    `${LOC_BASE}?q=${encodeURIComponent(city.display)}&fa=location:${cityFacet}|online-format:image&dates=1800/1980&fo=json&c=${pageSize}&sp={page}`,
    `${LOC_BASE}?q=${encodeURIComponent(`${city.display} architecture`)}&fa=location:${cityFacet}|online-format:image&dates=1800/1980&fo=json&c=${pageSize}&sp={page}`,
    `${LOC_BASE}?q=${encodeURIComponent(`${city.display} street`)}&fa=location:${cityFacet}|online-format:image&dates=1800/1980&fo=json&c=${pageSize}&sp={page}`,
    `${LOC_BASE}?q=${encodeURIComponent(`${city.display} building`)}&fa=location:${cityFacet}|online-format:image&dates=1800/1980&fo=json&c=${pageSize}&sp={page}`,
  ];

  for (const tpl of queries) {
    let page = 1;
    while (rows.length < target && page <= 8) {
      const url = tpl.replace("{page}", String(page));
      const data = await fetchJson(url);
      const results = Array.isArray(data.results) ? data.results : [];
      if (results.length === 0) break;
      rows.push(...results.map((item) => mapLocRecord(item, city)));
      page += 1;
    }
    if (rows.length >= target) break;
  }
  return rows;
}

async function fetchDpla(city, target) {
  if (!DPLA_API_KEY) {
    throw new Error("Missing DPLA_API_KEY environment variable.");
  }
  const rows = [];
  const pageSize = 100;
  const querySets = [
    {
      "sourceResource.spatial.city": city.display,
      "sourceResource.date.after": "1800",
      "sourceResource.date.before": "1980",
      page_size: String(pageSize),
    },
    {
      q: `${city.display} architecture`,
      "sourceResource.date.after": "1800",
      "sourceResource.date.before": "1980",
      page_size: String(pageSize),
    },
    {
      q: `${city.display} building`,
      "sourceResource.date.after": "1800",
      "sourceResource.date.before": "1980",
      page_size: String(pageSize),
    },
    {
      "sourceResource.spatial.coordinates": city.bbox,
      "sourceResource.date.after": "1800",
      "sourceResource.date.before": "1980",
      page_size: String(pageSize),
    },
  ];

  for (const q of querySets) {
    let page = 1;
    while (rows.length < target && page <= 8) {
      const params = new URLSearchParams({
        ...q,
        page: String(page),
        api_key: DPLA_API_KEY,
      });
      const url = `${DPLA_BASE}?${params.toString()}`;
      const data = await fetchJson(url);
      const docs = Array.isArray(data.docs) ? data.docs : [];
      if (docs.length === 0) break;
      rows.push(...docs.map((doc) => mapDplaRecord(doc, city)));
      page += 1;
    }
    if (rows.length >= target) break;
  }
  return rows;
}

async function main() {
  const cityArg = parseArg("--city", "San Francisco").toLowerCase();
  const target = Number(parseArg("--target", "220")) || 220;
  const city = CITY_CONFIG[cityArg];
  if (!city) {
    throw new Error(`Unsupported city "${cityArg}". Use San Francisco, Chicago, or New York.`);
  }

  const locRows = await fetchLoc(city, Math.ceil(target / 2));
  const dplaRows = await fetchDpla(city, Math.ceil(target / 2));
  const all = dedupeRecords([...locRows, ...dplaRows]).slice(0, target);

  const outDir = path.join(process.cwd(), "data-ingest");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${city.slug}-raw.json`);
  await fs.writeFile(outPath, JSON.stringify(all, null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        city: city.display,
        target,
        loc: locRows.length,
        dpla: dplaRows.length,
        written: all.length,
        file: outPath,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
