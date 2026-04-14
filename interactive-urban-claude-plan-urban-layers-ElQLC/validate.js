#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");

function parseArg(name, fallback = "") {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1).trim();
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1].trim();
  return fallback;
}

function toRad(n) {
  return (n * Math.PI) / 180;
}

function metersBetween(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function validate(records) {
  const reviewIdx = new Set();
  const reasons = new Map();
  const titleBuckets = new Map();

  records.forEach((r, i) => {
    const why = [];
    const hasLatLng = Number.isFinite(r.lat) && Number.isFinite(r.lng);
    if (!hasLatLng) why.push("missing_lat_lng");
    if (!Number.isInteger(r.year) || r.year < 1800 || r.year > 1980) why.push("year_out_of_range");
    const titleKey = normalizeTitle(r.title);
    if (titleKey) {
      if (!titleBuckets.has(titleKey)) titleBuckets.set(titleKey, []);
      titleBuckets.get(titleKey).push(i);
    }
    if (why.length) {
      reviewIdx.add(i);
      reasons.set(i, why);
    }
  });

  for (const indexes of titleBuckets.values()) {
    for (let a = 0; a < indexes.length; a += 1) {
      for (let b = a + 1; b < indexes.length; b += 1) {
        const i = indexes[a];
        const j = indexes[b];
        const ri = records[i];
        const rj = records[j];
        if (!Number.isFinite(ri.lat) || !Number.isFinite(ri.lng) || !Number.isFinite(rj.lat) || !Number.isFinite(rj.lng)) {
          continue;
        }
        if (metersBetween(ri, rj) <= 100) {
          reviewIdx.add(i);
          reviewIdx.add(j);
          reasons.set(i, [...new Set([...(reasons.get(i) || []), "duplicate_title_within_100m"])]);
          reasons.set(j, [...new Set([...(reasons.get(j) || []), "duplicate_title_within_100m"])]);
        }
      }
    }
  }

  const clean = [];
  const review = [];
  records.forEach((r, i) => {
    if (reviewIdx.has(i)) {
      review.push({ ...r, validation_flags: reasons.get(i) || [] });
    } else {
      clean.push(r);
    }
  });
  return { clean, review };
}

async function main() {
  const citySlug = parseArg("--city", "san-francisco")
    .toLowerCase()
    .replace(/\s+/g, "-");
  const inPath = parseArg("--in", path.join(process.cwd(), "data-ingest", `${citySlug}-raw.json`));

  const raw = JSON.parse(await fs.readFile(inPath, "utf8"));
  const { clean, review } = validate(raw);

  const outDir = path.join(process.cwd(), "data-ingest");
  await fs.mkdir(outDir, { recursive: true });
  const cleanPath = path.join(outDir, `${citySlug}-clean.json`);
  const reviewPath = path.join(outDir, `${citySlug}-review.json`);
  await fs.writeFile(cleanPath, JSON.stringify(clean, null, 2), "utf8");
  await fs.writeFile(reviewPath, JSON.stringify(review, null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        city: citySlug,
        input: raw.length,
        clean: clean.length,
        review: review.length,
        cleanFile: cleanPath,
        reviewFile: reviewPath,
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
