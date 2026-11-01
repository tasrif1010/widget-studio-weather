// Provider credentials stay in server environment variables.
// The small cache below is per process; the Netlify CDN supplies shared caching.
function memoryCache() {
  const entries = new Map();
  return {
    async match(key) {
      const row=entries.get(key.url);
      if (!row) return undefined;
      if (Date.now() >= row.expires) { entries.delete(key.url); return undefined; }
      return new Response(row.body, {status:row.status, headers:row.headers});
    },
    async put(key,response,ttl) {
      // Bound memory even when many different cities are requested.
      if (entries.size >= 128 && !entries.has(key.url)) entries.delete(entries.keys().next().value);
      entries.set(key.url,{body:await response.text(),status:response.status,headers:[...response.headers],expires:Date.now()+ttl*1000});
    }
  };
}
// WeatherAPI secret lives in env.WEATHER_API_KEY, never in the Android app.

function json(value, status = 200, ttl = 0) {
  return new Response(JSON.stringify(value), {status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': ttl ? 'public, max-age=60' : 'no-store',
    'Netlify-CDN-Cache-Control': ttl ? `public, max-age=${ttl}, durable` : 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Netlify-Vary': 'query',
    ...(status === 429 ? {'Retry-After': '60'} : {})
  }});
}
const error = (code, status) => json({error: {code}}, status);
const text = value => typeof value === 'string' ? value.slice(0, 180) : '';
function pick(value, fields) {
  const result = {};
  for (const field of fields) if (Number.isFinite(value?.[field])) result[field] = value[field];
  return result;
}
function weather(raw) {
  if (!Number.isFinite(raw?.current?.temp_c)) throw Error('Invalid upstream data');
  const current = pick(raw.current, ['temp_c','humidity','feelslike_c','wind_kph','wind_degree','uv']);
  current.wind_dir = text(raw.current.wind_dir);
  current.condition = {text: text(raw.current.condition?.text)};
  const band = raw.current.air_quality?.['us-epa-index'];
  if (Number.isInteger(band) && band >= 1 && band <= 6) current.air_quality = {'us-epa-index': band};
  return {location: {tz_id: text(raw.location?.tz_id), localtime: text(raw.location?.localtime)}, current,
    forecast: {forecastday: (raw.forecast?.forecastday || []).slice(0,3).map(day => ({
      date: text(day.date), day: {...pick(day.day, ['maxtemp_c','mintemp_c']), condition: {text: text(day.day?.condition?.text)}},
      hour: (day.hour || []).slice(0,24).map(hour => ({time: text(hour.time), ...pick(hour,['temp_c']), condition: {text: text(hour.condition?.text)}}))
    }))}};
}
function cities(raw) {
  if (!Array.isArray(raw)) throw Error('Invalid upstream data');
  return raw.slice(0,20).filter(row => Number.isFinite(row.lat) && Number.isFinite(row.lon) && Math.abs(row.lat)<=90 && Math.abs(row.lon)<=180)
    .map(row => ({name:text(row.name),region:text(row.region),country:text(row.country),lat:row.lat,lon:row.lon}));
}
export function createWeatherService({fetcher = (input, init) => fetch(input, init), cache = memoryCache()} = {}) {
  const inflight = new Map();
  async function upstream(route, query, secret, aqi = true) {
    const url = new URL(`https://api.weatherapi.com/v1/${route === 'search' ? 'search' : 'forecast'}.json`);
    url.searchParams.set('key',secret); url.searchParams.set('q',query);
    if (route === 'forecast') for (const [k,v] of Object.entries({days:'3',aqi:aqi?'yes':'no',alerts:'no',lang:'en'})) url.searchParams.set(k,v);
    const response = await fetcher(url, {redirect:'error', signal:AbortSignal.timeout(8000), headers:{Accept:'application/json'}});
    // Read a bounded body. Never forward upstream error bodies or log URLs/exceptions.
    const reader = response.body?.getReader(); if (!reader) throw Error('Empty upstream');
    let length = 0; const chunks = [];
    try { while (true) { const {done,value} = await reader.read(); if (done) break; length += value.byteLength; if (length > 1500000) {await reader.cancel(); throw Error('Too large');} chunks.push(value); }} finally { reader.releaseLock(); }
    const all = new Uint8Array(length); let offset = 0; for (const chunk of chunks) {all.set(chunk,offset); offset+=chunk.length;}
    const raw = JSON.parse(new TextDecoder().decode(all));
    if (route === 'forecast' && aqi && raw.error?.code === 2009) return upstream(route,query,secret,false);
    if (!response.ok || raw.error) return error(raw.error?.code === 1006 ? 'CITY_NOT_FOUND' : 'WEATHER_UNAVAILABLE', raw.error?.code === 1006 ? 400 : 503);
    return json(route === 'search' ? cities(raw) : weather(raw),200,route==='search'?86400:1800);
  }
  return {async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED',405);
      if (url.pathname === '/health') return json({ok:!!env.WEATHER_API_KEY && env.WEATHER_ENABLED !== 'false'},env.WEATHER_API_KEY&&env.WEATHER_ENABLED !== 'false'?200:503);
      const route = {'/v1/forecast':'forecast','/v1/search':'search'}[url.pathname];
      if (!route) return error('NOT_FOUND',404);
      // An APK cannot keep a shared client secret. Use server-side limits, not a fake app API key.
      if (!env.WEATHER_API_KEY || env.WEATHER_ENABLED === 'false') return error('WEATHER_UNAVAILABLE',503);
      if ([...url.searchParams.keys()].some(key=>key!=='q') || url.searchParams.getAll('q').length!==1) return error('INVALID_QUERY',400);
      let query = (url.searchParams.get('q')||'').trim().replace(/\s+/g,' ');
      if (route === 'forecast') {
        if (!/^-?\d{1,3}(\.\d{1,8})?,-?\d{1,3}(\.\d{1,8})?$/.test(query)) return error('INVALID_LOCATION',400);
        const [lat,lon]=query.split(',').map(Number); if (Math.abs(lat)>90||Math.abs(lon)>180) return error('INVALID_LOCATION',400);
        query=`${lat.toFixed(3)},${lon.toFixed(3)}`;
      } else if (query.length<2 || query.length>100 || /[\x00-\x1f\x7f]/.test(query)) return error('INVALID_CITY',400);
      const cacheUrl = new URL(`/cache-v1/${route}`, url.origin); cacheUrl.searchParams.set('q',query.toLowerCase());
      const cacheKey = new Request(cacheUrl); const store = cache; const hit = await store.match(cacheKey); if (hit) return hit;
      // Deduplicate concurrent requests in this isolate; edge cache is not a global quota counter.
      const id=cacheUrl.href;
      if (!inflight.has(id)) inflight.set(id,(async()=>{const result=await upstream(route,query,env.WEATHER_API_KEY);if(result.ok) await store.put(cacheKey,result.clone(),route==='search'?86400:1800);return result;})().finally(()=>inflight.delete(id)));
      return (await inflight.get(id)).clone();
    } catch (_) { return error('WEATHER_UNAVAILABLE',503); }
  }};
}

