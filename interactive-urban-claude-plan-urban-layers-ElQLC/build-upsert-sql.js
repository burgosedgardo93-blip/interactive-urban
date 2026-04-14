#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");

function sqlStr(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNum(value) {
  return Number.isFinite(value) ? String(value) : "NULL";
}

async function main() {
  const city = process.argv[2];
  if (!city) throw new Error("Usage: node build-upsert-sql.js <city-slug>");
  const cleanPath = path.join(process.cwd(), "data-ingest", `${city}-clean.json`);
  const rows = JSON.parse(await fs.readFile(cleanPath, "utf8"));

  const tuples = rows
    .map((r) => {
      return `(${sqlStr(r.id)}, ${sqlNum(r.year)}, ${sqlStr(r.title)}, ${sqlStr(
        r.category
      )}, ${sqlNum(r.lat)}, ${sqlNum(r.lng)}, ${sqlStr(r.source || "dpla")}, true)`;
    })
    .join(",\n");

  const sql = `INSERT INTO public.records (id, year, title, category, lat, lng, source, verified)
VALUES
${tuples}
ON CONFLICT (id) DO UPDATE SET
  year = EXCLUDED.year,
  title = EXCLUDED.title,
  category = EXCLUDED.category,
  lat = EXCLUDED.lat,
  lng = EXCLUDED.lng,
  source = EXCLUDED.source,
  verified = true;`;

  const outPath = path.join(process.cwd(), "data-ingest", `${city}-upsert.sql`);
  await fs.writeFile(outPath, sql, "utf8");
  console.log(outPath);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
