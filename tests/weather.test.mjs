import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWeatherService as createWorker} from '../src/weather.mjs';
import {config} from '../netlify/functions/weather.mjs';
const secret='test-provider-secret-not-real';
const request=(path,method='GET')=>new Request('https://weather.example'+path,{method,headers:{'CF-Connecting-IP':'192.0.2.10'}});
function setup(handler) {
  let calls=[]; const saved=new Map();
  const env={WEATHER_API_KEY:secret,WEATHER_LIMITER:{limit:async()=>({success:true})}};
  const worker=createWorker({fetcher:async(url,opts)=>{calls.push(new URL(url));return handler(url,opts);},cache:({match:async key=>saved.get(key.url)?.clone(),put:async(key,res)=>{saved.set(key.url,res);}})});
  return {env,calls,saved,run:(path,method)=>worker.fetch(request(path,method),env)};
}
const fixture=()=>({location:{tz_id:'Asia/Dhaka',localtime:'2026-10-29 16:00'},current:{temp_c:30,uv:0,wind_dir:'NW',condition:{text:'Sunny'},secret},forecast:{forecastday:Array.from({length:5},(_,i)=>({date:'2026-10-'+(29+i),day:{maxtemp_c:32,mintemp_c:22},hour:[]}))},secret});
test('provider key used only upstream; shared cache; three days and UV zero preserved',async()=>{
  const s=setup(()=>Response.json(fixture()));const a=await s.run('/v1/forecast?q=23.8,90.4');assert.equal(a.status,200);
  const body=await a.json();assert.equal(body.forecast.forecastday.length,3);assert.equal(body.current.uv,0);assert(!JSON.stringify(body).includes(secret));
  assert.equal(s.calls[0].origin,'https://api.weatherapi.com');assert.equal(s.calls[0].searchParams.get('key'),secret);
  await s.run('/v1/forecast?q=23.8001,90.4001');assert.equal(s.calls.length,1);
  assert(![...s.saved.keys()].join().includes(secret));
});
test('raw errors never echoed; cache does not store errors',async()=>{
  const s=setup(()=>Response.json({error:{code:2006,message:secret}},{status:403}));
  const r=await s.run('/v1/forecast?q=23,90');assert.equal(r.status,503);assert(!(await r.text()).includes(secret));assert.equal(s.saved.size,0);
});
test('AQI plan restriction retries once without AQI',async()=>{
  const s=setup(url=>new URL(url).searchParams.get('aqi')==='yes'?Response.json({error:{code:2009}},{status:403}):Response.json(fixture()));
  assert.equal((await s.run('/v1/forecast?q=23,90')).status,200);assert.equal(s.calls.length,2);assert.equal(s.calls[1].searchParams.get('aqi'),'no');
});
test('rejects arbitrary proxy inputs, injected keys, missing config',async()=>{
  const s=setup(()=>{throw Error('Must not fetch');});
  for(const path of ['/v1/forecast?q=https://evil.test','/v1/forecast?q=91,90','/v1/forecast?q=23,90&key=leak','/v1/search?q=A','/v1/search?q=Dhaka&q=other'])assert.equal((await s.run(path)).status,400);
  assert.equal((await s.run('/arbitrary')).status,404);assert.equal((await s.run('/v1/search?q=Dhaka','POST')).status,405);
  
  delete s.env.WEATHER_API_KEY;assert.equal((await s.run('/v1/search?q=Dhaka')).status,503);assert.equal(s.calls.length,0);
});
test('city results whitelist fields; no provider metadata',async()=>{
  const s=setup(()=>Response.json([{name:'Uttara',region:'Dhaka',country:'Bangladesh',lat:23.8,lon:90.4,secret},{name:'bad',lat:200,lon:90}]));
  const r=await s.run('/v1/search?q=Uttara');const data=await r.json();assert.equal(data.length,1);assert.equal(data[0].name,'Uttara');assert(!JSON.stringify(data).includes(secret));
});
test('exceptions and redirects do not expose secret URLs',async()=>{
  const s=setup((url,opts)=>{assert.equal(opts.redirect,'error');throw Error(url.toString());});
  const r=await s.run('/v1/forecast?q=23,90');assert.equal(r.status,503);assert(!(await r.text()).includes(secret));
});

test('Netlify routes, rate limit and query cache variation are explicit',async()=>{
  assert.deepEqual(config.path,['/health','/v1/forecast','/v1/search']);
  assert.deepEqual(config.rateLimit,{action:'rate_limit',windowLimit:20,windowSize:60,aggregateBy:['ip','domain']});
  const s=setup(()=>Response.json(fixture()));const result=await s.run('/v1/forecast?q=23,90');
  assert.equal(result.headers.get('Netlify-Vary'),'query');
  assert.equal(result.headers.get('Netlify-CDN-Cache-Control'),'public, max-age=1800, durable');
  s.env.WEATHER_ENABLED='false';assert.equal((await s.run('/v1/forecast?q=23,90')).status,503);
});
test('health confirms configuration only and never returns secret',async()=>{
  const s=setup(()=>{throw Error('No provider calls for health');});
  assert.deepEqual(await (await s.run('/health')).json(),{ok:true});
  s.env.WEATHER_ENABLED='false';assert.equal((await s.run('/health')).status,503);
  assert.equal(s.calls.length,0);
});
