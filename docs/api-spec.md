# Urban Layers — External API Spec
**Purpose:** Define integration contracts for two public APIs that will supply historical San Francisco photo/record data to populate the `{id, year, title, category, desc, lat, lng, architect, demolished, img}` data model.

---

## 1. Library of Congress Photos API

### Base URL & Format
```
https://www.loc.gov/photos/?fo=json
https://www.loc.gov/search/?fo=json        # cross-collection search
https://www.loc.gov/item/{item_id}/?fo=json # single-item detail
```
All endpoints accept `fo=json` to return JSON instead of HTML. No base path versioning.

### Authentication
**None required.** The loc.gov JSON/YAML API is fully public with no API key. Rate limiting is enforced server-side; exact thresholds are not published. Recommendation: ≤1 req/sec, cache aggressively.

### Rate Limits
| Limit | Value |
|-------|-------|
| API key required | No |
| Published RPS cap | Not specified |
| Max pageable result index | 100,000th item |
| Recommended interval | ~1 req/sec |

### Query Parameters
| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `q` | string | Full-text keyword search | `q=san+francisco+earthquake` |
| `fo` | enum | Response format | `fo=json` |
| `dates` | string | Year range (inclusive) | `dates=1850/1906` |
| `start_date` | date | ISO date lower bound | `start_date=1906-04-18` |
| `end_date` | date | ISO date upper bound | `end_date=1906-12-31` |
| `fa` | string | Facet filter (pipe-delimited) | `fa=location:san+francisco\|online-format:image` |
| `c` | int | Results per page | `c=50` (options: 25, 50, 100, 150) |
| `sp` | int | Page number (1-indexed) | `sp=2` |

**Facet filter values for `fa=`:**
| Facet key | Purpose | SF example |
|-----------|---------|------------|
| `location:{city}` | Named location filter | `location:san+francisco` |
| `subject:{term}` | LOC subject heading | `subject:architecture` |
| `online-format:{type}` | Available online as | `online-format:image` |
| `original-format:{type}` | Physical format | `original-format:photo,+print,+drawing` |
| `contributor:{name}` | Photographer/creator | `contributor:lange,+dorothea` |
| `partof:{collection}` | Restrict to collection | `partof:historic+american+buildings+survey` |

### Pagination
Response includes a `pagination` object:
```json
{
  "pagination": {
    "current": 1,
    "total": 847,
    "perpage": 25,
    "from": 1,
    "to": 25,
    "next": "https://www.loc.gov/photos/?...&sp=2&fo=json",
    "previous": null,
    "perpage_options": [25, 50, 100, 150]
  }
}
```
Page through using the `next` URL directly, or manually increment `sp`. Hard cap at result index 100,000.

### Date/Location Metadata Available in Records
| Field | Path in JSON | Notes |
|-------|-------------|-------|
| Date string | `results[n].date` | Free-form string, e.g. "1906", "ca. 1890-1900" |
| Subjects | `results[n].subject[]` | LOC subject headings array |
| Location facet | `results[n].location[]` | Named locations array |
| Place of publication | `results[n].place_of_publication` | City/state string |
| **Coordinates** | — | **Not provided.** No lat/lng in standard response. |

> **Important:** LOC does not return lat/lng. Records tagged `location:san+francisco` will need their coordinates hardcoded or geocoded.

### Image URL Format
Each result contains a `resources` array:
```json
"resources": [{
  "small":  "https://lcweb2.loc.gov/service/pnp/ppmsca/03000/03034t.gif",
  "medium": "https://lcweb2.loc.gov/service/pnp/ppmsca/03000/03034r.jpg",
  "large":  "https://lcweb2.loc.gov/service/pnp/ppmsca/03000/03034v.jpg",
  "larger": "https://lcweb2.loc.gov/master/pnp/ppmsca/03000/03034u.tif"
}]
```
URL pattern: `https://lcweb2.loc.gov/service/pnp/{coll}/{group}/{item}{size}.{ext}`
- `t` suffix → small thumbnail (GIF)
- `r` suffix → medium display (JPG) — **recommended for map popups**
- `v` suffix → large (JPG)
- `u` suffix → master TIFF

### Recommended SF Query Strategy
```
# Architectural/building photos, broad date sweep
GET https://www.loc.gov/photos/?q=san+francisco&fa=location:san+francisco|online-format:image&dates=1850/1960&fo=json&c=100

# HABS architectural records (includes architect metadata)
GET https://www.loc.gov/photos/?fa=partof:historic+american+buildings+survey|location:san+francisco&fo=json&c=100

# 1906 earthquake documentation
GET https://www.loc.gov/photos/?q=san+francisco+earthquake&dates=1906/1910&fo=json&c=100

# Pre-fire Victorian SF
GET https://www.loc.gov/photos/?fa=location:san+francisco&dates=1850/1905&fo=json&c=100
```

### Field Mapping → App Data Model
| App field | LOC source path | Transform |
|-----------|----------------|-----------|
| `id` | Extract from `url` path | e.g. `url = "https://www.loc.gov/item/2017771068/"` → id = `"loc-2017771068"` |
| `year` | `results[n].date` | Parse first 4-digit year with regex `/\b(1[7-9]\d{2})\b/` |
| `title` | `results[n].title` | String, trim trailing slashes |
| `category` | `results[n].original_format[]` or `subject[]` | Map to enum: "photo", "drawing", "map" |
| `desc` | `results[n].description[0]` | First element of array |
| `lat` | — | **Hardcode SF centroid (37.7749) or skip** |
| `lng` | — | **Hardcode SF centroid (-122.4194) or skip** |
| `architect` | `results[n].contributor[]` | First contributor; HABS records often name the architect |
| `demolished` | — | **Not in metadata; leave null** |
| `img` | `results[n].resources[0].medium` | Prefer `medium` (JPG); fall back to `small` |

---

## 2. DPLA API

### Base URL
```
https://api.dp.la/v2/items
https://api.dp.la/v2/collections
https://api.dp.la/v2/items/{id}   # single item
```

### Authentication
**API key required.** Free, instant provisioning:
```bash
# One-time key request (replace with real email)
curl -X POST https://api.dp.la/v2/api_key/you@example.com
# Key arrives via email; 32-character alphanumeric string
```
Append to every request: `&api_key=YOUR_32_CHAR_KEY`

### Rate Limits
| Limit | Value |
|-------|-------|
| Published RPS cap | Not specified ("best effort") |
| Abuse policy | DPLA reserves right to revoke on service degradation |
| Recommended practice | Paginate sequentially; avoid concurrent bursts |

### Query Parameters
| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `q` | string | Full-text keyword search | `q=mission+district` |
| `page_size` | int | Results per page (max 500) | `page_size=50` |
| `page` | int | Page number (1-indexed) | `page=2` |
| `sourceResource.title` | string | Title field search | `sourceResource.title=ferry+building` |
| `sourceResource.description` | string | Description search | |
| `sourceResource.creator` | string | Creator/photographer | |
| `sourceResource.date.after` | string | Lower date bound | `sourceResource.date.after=1900` |
| `sourceResource.date.before` | string | Upper date bound | `sourceResource.date.before=1960` |
| `sourceResource.subject.name` | string | Subject keyword | `sourceResource.subject.name=architecture` |
| `sourceResource.format` | string | Format type | `sourceResource.format=photograph` |
| `sourceResource.spatial.name` | string | Named location | `sourceResource.spatial.name=San+Francisco` |
| `sourceResource.spatial.state` | string | US state (full name) | `sourceResource.spatial.state=California` |
| `sourceResource.spatial.city` | string | City name | `sourceResource.spatial.city=San+Francisco` |
| `sourceResource.spatial.coordinates` | string | Point or bbox (see below) | |
| `sourceResource.spatial.distance` | string | Radius from point | `sourceResource.spatial.distance=5mi` |
| `sort_by` | string | Sort field | `sort_by=sourceResource.date.begin` |
| `sort_order` | enum | `asc` / `desc` | `sort_order=asc` |

### Geographic Bounding Box
```
# Format: "upper-left-lat,upper-left-lng:lower-right-lat,lower-right-lng"
sourceResource.spatial.coordinates=37.93,-122.52:37.70,-122.35

# San Francisco city bbox (WGS84):
#   NW corner: 37.9298, -122.5153
#   SE corner: 37.6968, -122.3570
```

### Date Range Filtering
```
# Records between 1870 and 1945
sourceResource.date.after=1870&sourceResource.date.before=1945

# Note: values are year strings; full ISO dates also accepted
```

### Pagination
Response structure:
```json
{
  "count": 3847,
  "start": 0,
  "limit": 50,
  "docs": [ ... ]
}
```
- `count` — total matching records
- `start` — zero-based offset of first result
- `limit` — records in this response
- Navigate by incrementing `page`; `page_size` controls page size (max 500)

### Standardized Fields (sourceResource)
```
sourceResource.title          — string or array of strings
sourceResource.description    — string or array
sourceResource.creator        — string or array (photographer, architect)
sourceResource.contributor    — string or array
sourceResource.date           — object: { begin, end, displayDate }
sourceResource.format         — string or array (e.g. "photograph", "glass negative")
sourceResource.subject        — array of { name, @id, @type }
sourceResource.spatial        — array of { name, city, county, state, country, coordinates }
sourceResource.rights         — string
sourceResource.language       — array of { name, iso639_3 }
sourceResource.type           — string (resource type)
```

Top-level aggregation fields:
```
@id           — full DPLA item URI (stable)
_id           — short internal ID
dataProvider  — contributing institution name
isShownAt     — URL to item on provider's site
isShownBy     — URL to thumbnail/preview image  (primary image field)
object.@id    — URL to full-resolution digital object
```

### Recommended SF Query Strategy
```
# Broad SF photograph sweep (paginate all pages)
GET https://api.dp.la/v2/items?sourceResource.spatial.city=San+Francisco
    &sourceResource.format=photograph
    &sourceResource.date.after=1840&sourceResource.date.before=1970
    &sort_by=sourceResource.date.begin&sort_order=asc
    &page_size=100&page=1
    &api_key=KEY

# Bounding box (catches items tagged with coordinates)
GET https://api.dp.la/v2/items?sourceResource.spatial.coordinates=37.93,-122.52:37.70,-122.35
    &sourceResource.date.after=1840
    &page_size=100
    &api_key=KEY

# Architecture-specific
GET https://api.dp.la/v2/items?sourceResource.spatial.city=San+Francisco
    &sourceResource.subject.name=architecture
    &sourceResource.format=photograph
    &page_size=100
    &api_key=KEY

# 1906 earthquake
GET https://api.dp.la/v2/items?q=san+francisco+earthquake
    &sourceResource.date.after=1906&sourceResource.date.before=1910
    &page_size=100
    &api_key=KEY
```

### Field Mapping → App Data Model
| App field | DPLA source path | Transform |
|-----------|-----------------|-----------|
| `id` | `_id` | Prefix: `"dpla-" + _id` |
| `year` | `sourceResource.date.begin` | Parse integer year; fall back to `date.displayDate` regex |
| `title` | `sourceResource.title` | If array, take `[0]`; trim whitespace |
| `category` | `sourceResource.format` or `sourceResource.type` | Map "photograph"→"photo", "drawing"→"drawing", etc. |
| `desc` | `sourceResource.description` | If array, join with space or take `[0]` |
| `lat` | `sourceResource.spatial[0].coordinates` | Split `"37.77,-122.41"` on `,` → index 0 as float |
| `lng` | `sourceResource.spatial[0].coordinates` | Split on `,` → index 1 as float |
| `architect` | `sourceResource.creator` | If array, take `[0]`; may be photographer, not architect |
| `demolished` | — | **Not in standard fields; leave null** |
| `img` | `isShownBy` | Thumbnail URL; fall back to `object.@id` if null |

---

## 3. Comparison & Integration Notes

| Concern | LOC | DPLA |
|---------|-----|------|
| Auth | None | API key (free) |
| Coordinates on records | Rarely / never | Sometimes (`spatial.coordinates`) |
| Architect metadata | HABS collection only | `sourceResource.creator` (usually photographer) |
| Date precision | Free-text string | Structured `begin`/`end` year ints |
| Image availability | Almost always (`resources[]`) | `isShownBy` often null for older records |
| SF collection depth | Strong (HABS, FSA, PPOC) | Strong (SF Public Library via Calisphere) |
| Bounding box filter | No | Yes |
| Rate limit clarity | Opaque | Opaque (best-effort) |
| Best for | Architecture drawings, HABS docs | Geo-tagged photos with structured dates |

### Coordinate Gap Mitigation
Neither API reliably returns precise building lat/lng. Recommended strategies:
1. **HABS records** (LOC) often include street addresses — geocode with Nominatim/Google after fetch.
2. **DPLA `spatial.coordinates`** when present is city-level centroid, not building-level.
3. Maintain a local address→coordinate lookup table for known SF landmarks.
4. For MVP, cluster all API-sourced records at the SF centroid (`37.7749, -122.4194`) with small random jitter, then refine manually.

### Demolished Field Gap
Neither API carries a "demolished" flag. Options:
- Leave `null` for all API-sourced records.
- Maintain a manual override map keyed by `title`+`year`.
- Add a community-editable layer later.

---

## 4. Suggested Fetch Pipeline (architecture only)

```
1. DPLA  — fetch SF photos by bounding box, paginate all pages → normalize → dedupe by title+year
2. LOC   — fetch HABS SF records (best architect metadata)      → normalize → merge
3. LOC   — fetch FSA/PPOC SF photos                            → normalize → merge
4. Geocode any records with street addresses but no coordinates
5. Persist normalized records to local JSON or IndexedDB
6. Layer results onto Leaflet map using existing category/year filters
```

---

## 5. Useful Collections to Target

| Collection | API | Notes |
|-----------|-----|-------|
| Historic American Buildings Survey (HABS) | LOC | Architect names, measured drawings, strong SF coverage |
| Farm Security Administration (FSA/OWI) | LOC | 1930s–40s SF street photography |
| Prints & Photographs Online Catalog (PPOC) | LOC | Broad historical coverage |
| SF Public Library Historical Photos | DPLA | ~55,000 images via Calisphere aggregator |
| Lawrence & Houseworth Stereographs | LOC | Mid-19th century SF imagery |
