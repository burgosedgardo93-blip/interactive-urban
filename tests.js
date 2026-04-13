// tests.js — Urban Layers temporal layer unit tests
// Run with: node tests.js
//
// Tests the pure getMarkerState(record, year) function in isolation.
// No browser or Leaflet dependency — all logic is inlined here.

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION UNDER TEST (must stay in sync with index.html)
//
// Returns one of three states for a record at a given slider year:
//   "future"  — r.year > year          → hidden entirely
//   "ghost"   — demolished <= year     → faded marker with dashed border
//   "normal"  — built and standing     → full-opacity marker
// ─────────────────────────────────────────────────────────────────────────────

function getMarkerState(r, year) {
  if (r.year > year) return "future";
  if (r.demolished !== null && r.demolished <= year) return "ghost";
  return "normal";
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST HARNESS
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  \u2713 ${message}`);
    passed++;
  } else {
    console.error(`  \u2717 FAIL: ${message}`);
    failed++;
  }
}

function assertEqual(actual, expected, message) {
  const ok = actual === expected;
  assert(ok, ok ? message : `${message} — expected "${expected}", got "${actual}"`);
}

function section(name) {
  console.log(`\n${name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES  (year/demolished taken directly from BASE_RECORDS in index.html)
// ─────────────────────────────────────────────────────────────────────────────

const FERRY_BUILDING    = { id: "sf-001", year: 1898, demolished: null  }; // never demolished
const SUTRO_BATHS       = { id: "sf-004", year: 1896, demolished: 1966  }; // fire 1966
const EMBARCADERO_FWY   = { id: "sf-006", year: 1959, demolished: 1991  }; // post-earthquake
const TRANSAMERICA      = { id: "sf-003", year: 1972, demolished: null  }; // still standing
const WOODWARDS_GARDENS = { id: "sf-012", year: 1866, demolished: 1894  }; // 19th-c amusement park
const MISSION_DOLORES   = { id: "sf-010", year: 1791, demolished: null  }; // oldest SF building

// ─────────────────────────────────────────────────────────────────────────────
// RECORD 1 — Ferry Building (1898, not demolished)
// ─────────────────────────────────────────────────────────────────────────────

section("Ferry Building — built 1898, never demolished");
assertEqual(getMarkerState(FERRY_BUILDING, 1897), "future", "hidden the year before construction");
assertEqual(getMarkerState(FERRY_BUILDING, 1898), "normal", "normal in the year it was built");
assertEqual(getMarkerState(FERRY_BUILDING, 1950), "normal", "normal mid-century");
assertEqual(getMarkerState(FERRY_BUILDING, 2024), "normal", "normal today");

// ─────────────────────────────────────────────────────────────────────────────
// RECORD 2 — Sutro Baths (1896–1966)
// ─────────────────────────────────────────────────────────────────────────────

section("Sutro Baths — built 1896, demolished 1966");
assertEqual(getMarkerState(SUTRO_BATHS, 1895), "future", "hidden before construction");
assertEqual(getMarkerState(SUTRO_BATHS, 1896), "normal", "normal in year built");
assertEqual(getMarkerState(SUTRO_BATHS, 1930), "normal", "normal while standing");
assertEqual(getMarkerState(SUTRO_BATHS, 1965), "normal", "normal one year before demolition");
assertEqual(getMarkerState(SUTRO_BATHS, 1966), "ghost",  "ghost in year of demolition");
assertEqual(getMarkerState(SUTRO_BATHS, 2000), "ghost",  "ghost long after demolition");

// ─────────────────────────────────────────────────────────────────────────────
// RECORD 3 — Embarcadero Freeway (1959–1991)
// ─────────────────────────────────────────────────────────────────────────────

section("Embarcadero Freeway — built 1959, demolished 1991");
assertEqual(getMarkerState(EMBARCADERO_FWY, 1958), "future", "hidden before construction");
assertEqual(getMarkerState(EMBARCADERO_FWY, 1959), "normal", "normal in year built");
assertEqual(getMarkerState(EMBARCADERO_FWY, 1975), "normal", "normal mid-life");
assertEqual(getMarkerState(EMBARCADERO_FWY, 1990), "normal", "normal one year before demolition");
assertEqual(getMarkerState(EMBARCADERO_FWY, 1991), "ghost",  "ghost in year of demolition");
assertEqual(getMarkerState(EMBARCADERO_FWY, 2020), "ghost",  "ghost in modern era");

// ─────────────────────────────────────────────────────────────────────────────
// RECORD 4 — Transamerica Pyramid (1972, not demolished)
// ─────────────────────────────────────────────────────────────────────────────

section("Transamerica Pyramid — built 1972, never demolished");
assertEqual(getMarkerState(TRANSAMERICA, 1971), "future", "hidden before construction");
assertEqual(getMarkerState(TRANSAMERICA, 1972), "normal", "normal in year built");
assertEqual(getMarkerState(TRANSAMERICA, 2000), "normal", "normal in 2000");

// ─────────────────────────────────────────────────────────────────────────────
// RECORD 5 — Woodward's Gardens (1866–1894)
// ─────────────────────────────────────────────────────────────────────────────

section("Woodward's Gardens — built 1866, demolished 1894");
assertEqual(getMarkerState(WOODWARDS_GARDENS, 1865), "future", "hidden before construction");
assertEqual(getMarkerState(WOODWARDS_GARDENS, 1866), "normal", "normal in opening year");
assertEqual(getMarkerState(WOODWARDS_GARDENS, 1880), "normal", "normal mid-operation");
assertEqual(getMarkerState(WOODWARDS_GARDENS, 1893), "normal", "normal one year before demolition");
assertEqual(getMarkerState(WOODWARDS_GARDENS, 1894), "ghost",  "ghost in demolition year");
assertEqual(getMarkerState(WOODWARDS_GARDENS, 1950), "ghost",  "ghost mid-century");
assertEqual(getMarkerState(WOODWARDS_GARDENS, 2024), "ghost",  "ghost today");

// ─────────────────────────────────────────────────────────────────────────────
// RECORD 6 — Mission Dolores (1791, oldest SF building)
// ─────────────────────────────────────────────────────────────────────────────

section("Mission Dolores — built 1791, never demolished");
assertEqual(getMarkerState(MISSION_DOLORES, 1790), "future", "hidden before construction");
assertEqual(getMarkerState(MISSION_DOLORES, 1791), "normal", "normal in founding year");
assertEqual(getMarkerState(MISSION_DOLORES, 1906), "normal", "normal in earthquake year");
assertEqual(getMarkerState(MISSION_DOLORES, 2024), "normal", "normal today");

// ─────────────────────────────────────────────────────────────────────────────
// BOUNDARY / EDGE CASES
// ─────────────────────────────────────────────────────────────────────────────

section("Edge cases — boundary years");

// Built year == viewYear: should be normal (inclusive)
assertEqual(
  getMarkerState({ year: 1900, demolished: null }, 1900),
  "normal",
  "built year equals viewYear → normal"
);

// Demolished year == viewYear: should be ghost (inclusive)
assertEqual(
  getMarkerState({ year: 1900, demolished: 1950 }, 1950),
  "ghost",
  "demolished year equals viewYear → ghost"
);

// One year before demolition: still normal
assertEqual(
  getMarkerState({ year: 1900, demolished: 1950 }, 1949),
  "normal",
  "year before demolition → normal"
);

// Built in same year it was demolished (edge case)
assertEqual(
  getMarkerState({ year: 1906, demolished: 1906 }, 1906),
  "ghost",
  "built and demolished same year → ghost (demolished check wins)"
);

// Future record with demolished date: still future
assertEqual(
  getMarkerState({ year: 2050, demolished: 2060 }, 2024),
  "future",
  "not-yet-built record → future even with a demolition date"
);

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`${passed + failed} assertions: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("\nSome tests failed.");
  process.exit(1);
} else {
  console.log("\nAll tests passed.");
}
