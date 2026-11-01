import {createWeatherService} from '../../src/weather.mjs';
const service=createWeatherService();
export default async function handler(request) {
  return service.fetch(request,{
    WEATHER_API_KEY:process.env.WEATHER_API_KEY,
    WEATHER_ENABLED:process.env.WEATHER_ENABLED
  });
}
// Netlify enforces this at the platform, including across function instances.
// Verify rule acceptance in the deploy post-processing log before release.
export const config={
  path:['/health','/v1/forecast','/v1/search'],
  rateLimit:{action:'rate_limit',windowLimit:20,windowSize:60,aggregateBy:['ip','domain']}
};
