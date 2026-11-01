# Widget Studio Weather

WeatherAPI proxy for the Android Widget Studio app, deployed with **Netlify Functions**.
No WeatherAPI key belongs in GitHub, app assets, APKs, URLs sent to users, or chat.
This repository contains backend source only. It does not deploy or configure a real secret by itself.

## Deploy from a phone

1. In Netlify, choose **Import an existing project → GitHub**.
2. Select **tasrif1010/widget-studio-weather**. If it is absent, grant the Netlify GitHub app access to this repository only.
3. Keep the repository root as the base directory. `netlify.toml` supplies the build command (`npm run build`), publish directory (`public`), and functions directory (`netlify/functions`).
4. Deploy. There are no application dependencies to install. The build runs the backend's automated tests.
5. Under the project's **Environment variables**, add `WEATHER_API_KEY` with your WeatherAPI Main key. Include the **Functions** scope, or all scopes if that is the available option. Use the secret/sensitive-value option if your plan offers it. Never prefix it with a frontend-public variable name.
6. Redeploy after adding the variable. You do not need a Cloudflare account, Worker, or limiter binding.

`WEATHER_ENABLED=false` disables new weather requests inside the function. To stop already-cached responses immediately, also purge the Netlify cache or perform a fresh deploy. Leaving this variable unset enables weather once a provider key is configured.

## Check the deployed service

Use the actual HTTPS origin Netlify assigns to the project:

| Path | Expected result |
| --- | --- |
| `/health` | `{"ok":true}` once the environment variable is present; this does not verify that the provider accepts the key |
| `/v1/search?q=Dhaka` | City choices |
| `/v1/forecast?q=23.8,90.4` | Current conditions and up to three forecast days |

`503` means weather is unavailable or setup is incomplete. Provider error bodies and exception details are not sent to clients.

Before release, check the deployment's post-processing log for acceptance of the code-based rate-limit rule. Invalid rules may not fail a Netlify deployment. Test the real deployed routes and limits; local tests cannot verify Netlify's CDN or platform rate limiting.

## Connect Android

The API paths and JSON fields match the v50 Android backend adapter. Once this service is verified, build with the deployed HTTPS origin:

```sh
python -u "$HOME/widget-backend-v50/update-data-v50.py" --backend-url "https://YOUR-ACTUAL-PROJECT.netlify.app"
```

Replace the example with the real project URL. This is an owner build setting. App users only select their city and never enter an API key. Do not rebuild Android until the live service works.

## Data and limits

- Three-day forecast, weather condition, temperature, humidity, wind, UV and available US EPA air-quality band. WeatherAPI attribution remains in the Android app.
- Only a fixed WeatherAPI HTTPS host and forecast/search routes are used. Redirects are disabled. Queries are validated and upstream bodies are size/time bounded.
- Only selected response fields are forwarded. Provider credentials and error details are excluded.
- Forecast responses request 30-minute Netlify CDN caching; city search requests 24-hour caching. Cache keys vary by all query parameters to keep cities separate.
- A bounded cache and concurrent request deduplication also run inside each function process. They are not shared across processes; Netlify provides the CDN layer.
- One code-based rate-limit rule requests 20 requests per 60 seconds per IP/domain. Mobile users can share an IP. Netlify enforcement is approximate and its deployment needs verification.
- These are public API routes. A private GitHub repository does not make the deployed weather API private. An API token embedded in an APK would be extractable.
- The initial limits are not app authentication or a strict global monthly provider budget. Before broad commercial distribution, add suitable abuse monitoring, stronger client verification and a shared budget mechanism, and review provider/hosting quotas.
- Only city queries/coordinates are sent to this backend. Fitness/Health Connect records are not sent here. The application code does not log queries, secret URLs or provider error bodies; hosting platforms may retain their own request metadata.

## Validation

Run `npm test` on Node.js 22 or newer. Eight mocked backend tests cover sanitized output, query and route validation, provider-error suppression, AQI fallback, cache reuse, deploy configuration and health responses. No real API key, live Netlify deployment or Android build has been tested as part of this repository's initial commit.

Official references:

- https://docs.netlify.com/build/functions/get-started/
- https://docs.netlify.com/build/functions/environment-variables/
- https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/
- https://docs.netlify.com/build/caching/caching-overview/
