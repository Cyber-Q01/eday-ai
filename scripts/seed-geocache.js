// Seeds geocode_cache with Nominatim results for major Nigerian hubs.
//
// WHY: the Supabase edge runtime's egress proxy currently blocks
// nominatim.openstreetmap.org, so server-side geocoding only works from a
// cache hit. Address→coordinate results for well-known areas barely ever
// change, so a one-time (or weekly) local seed keeps the AI quote flow fully
// functional — and faster — regardless of edge egress.
//
// Usage:  node scripts/seed-geocache.js
// Env:    SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF   (or edit below)

const REF = process.env.SUPABASE_PROJECT_REF;
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!REF || !TOKEN) {
  console.error('Set SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN in the environment (never commit them).');
  process.exit(1);
}

const PLACES = [
  // Lagos
  'Ikeja, Lagos', 'Yaba, Lagos', 'Victoria Island, Lagos', 'Lekki Phase 1, Lagos',
  'Surulere, Lagos', 'Ikorodu, Lagos', 'Murtala Muhammed Airport, Lagos',
  'Ikeja City Mall, Alausa, Lagos', 'Computer Village, Ikeja, Lagos', 'Ajah, Lagos',
  // Abuja
  'Jabi, Abuja', 'Wuse 2, Abuja', 'Garki, Abuja', 'Central Area, Abuja',
  'Gwarinpa, Abuja', 'Maitama, Abuja', 'Nnamdi Azikiwe International Airport, Abuja',
  'Utako, Abuja', 'Lugbe, Abuja', 'Kubwa, Abuja',
  // Ibadan & others
  'Bodija, Ibadan', 'Dugbe, Ibadan', 'University of Ibadan', 'Olomi, Ibadan',
  'Challenge, Ibadan', 'Port Harcourt', 'Kano', 'Benin City', 'Enugu', 'Kaduna',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function geocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
    q, format: 'json', limit: '1', countrycodes: 'ng', addressdetails: '0',
  })}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'ProjectEday/1.0 (support@eday.app)' } });
  if (!res.ok) return null;
  const hits = await res.json();
  return hits.length ? { lat: Number(hits[0].lat), lng: Number(hits[0].lon), label: hits[0].display_name } : null;
}

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`SQL failed: ${res.status} ${await res.text()}`);
  return res.json();
}

(async () => {
  let ok = 0;
  for (const place of PLACES) {
    const r = await geocode(place).catch(() => null);
    if (!r) {
      console.log(`· miss   ${place}`);
    } else {
      const key = place.toLowerCase().replace(/\s+/g, ' ');
      await sql(
        `insert into public.geocode_cache (key, lat, lng, label) values ('${key.replace(/'/g, "''")}', ${r.lat}, ${r.lng}, '${r.label.replace(/'/g, "''")}') ` +
        `on conflict (key) do update set lat = excluded.lat, lng = excluded.lng, label = excluded.label, created_at = now()`
      );
      ok++;
      console.log(`✓ cached ${place}  (${r.lat.toFixed(4)}, ${r.lng.toFixed(4)})`);
    }
    await sleep(1100); // Nominatim fair use: 1 req/s
  }
  console.log(`\nSeeded ${ok}/${PLACES.length} places into geocode_cache.`);
})();
