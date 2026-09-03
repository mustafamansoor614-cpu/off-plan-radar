# Off-Plan Radar

A small Netlify app: pick (or type) a competitor, it live-fetches their currently
running ads from Meta's **public** Ad Library, and generates an AI competitive
analysis on demand.

## How it works

- `public/index.html` — the whole frontend, one file, no build step.
- `netlify/functions/fetch-ads.js` — a serverless function that requests
  `facebook.com/ads/library` server-side (the same public page anyone can view
  in a browser, no login required) and pulls the ad data out of the JSON Meta
  embeds in that page's HTML.
- `netlify/functions/analyze.js` — sends the fetched ads to Claude or GPT and
  returns a short written analysis.

No database, no build tooling, no npm dependencies. Deploy as-is.

## Deploy it

1. **Push this folder to a GitHub repo** (or drag the whole folder onto
   [app.netlify.com/drop](https://app.netlify.com/drop) for a one-off deploy
   without git).
2. In Netlify: **Add new site → Import an existing project**, point it at the
   repo. Build settings are already set in `netlify.toml` — you don't need to
   change anything.
3. Once deployed, go to **Site configuration → Environment variables** and add
   **one** of:
   - `ANTHROPIC_API_KEY` — a key from [console.anthropic.com](https://console.anthropic.com) (checked first), or
   - `OPENAI_API_KEY` — a key from [platform.openai.com](https://platform.openai.com)

   This is what powers the "Generate analysis" button. Without it, ad
   fetching still works — you just won't get the AI write-up.
4. Redeploy (Netlify → Deploys → Trigger deploy) so the function picks up the
   new environment variable.
5. Open the site. Pick a competitor chip or type any advertiser name, pick a
   country, hit **Fetch ads**.

Optional environment variables:
- `ANTHROPIC_MODEL` (default `claude-sonnet-4-5`)
- `OPENAI_MODEL` (default `gpt-4o-mini`)

## Important — please read before you rely on this

**This is not an official Meta integration.** Meta's actual Ad Library API
only returns commercial (non-political) ads for the EU and UK — it can't see
UAE, US, or most other markets' regular product ads at all, no matter what
credentials you use. That's a hard limitation on Meta's side, not a bug here.

So `fetch-ads.js` instead reads the same **public**, no-login page a person
browsing facebook.com/ads/library would see, the same way this whole project
was scoped out. That means:

- **It relies on an unofficial, undocumented page structure.** Meta can
  change it at any time with no notice, which would break parsing until
  `extractAdsFromHtml()` in `fetch-ads.js` is updated to match. If you
  suddenly get "No ads could be parsed" for a competitor you know is
  advertising, this is the most likely reason — open an issue for yourself
  to fix the parser, or ask an AI assistant to look at the current page
  structure and update the extraction logic.
- **It's against Meta's automated-access terms of service**, even though no
  login or CAPTCHA bypass is involved and the data is publicly visible to
  anyone. Treat this as a personal research tool for your own competitive
  awareness — not something to put your name on publicly, resell, or run at
  high volume.
- **It can get rate-limited or blocked.** The function surfaces a clear error
  when that happens rather than failing silently; just wait a bit and retry.
- **Only the first batch of results is pulled** (Meta serves roughly the
  first 20–30 ads per search server-rendered; deeper pagination needs
  session tokens this tool deliberately doesn't try to replicate, since
  ~20-30 ads is already enough for a solid read on someone's current
  messaging).

## Lead-gen vs. roadshow/event filter

Every fetched ad is auto-tagged `leadgen` or `event` (`fetch-ads.js` →
`classifyAd()`), by scanning the ad's text against a phrase list: roadshow,
property/real-estate expo, exhibition, open house, sales event, "meet us",
"we're coming to your city", "join us on/at", save the date, city tour,
attendees, pop-up event, seminar. An ad with none of those is left as
`leadgen`. The card badge shows which phrase actually matched, and the
segmented control above the results ("All / Lead gen / Roadshows & events")
filters the grid — plus scopes the AI analysis to just that subset when you
hit "Generate analysis" while a filter is active.

To tune it: edit the `EVENT_PATTERNS` array in `fetch-ads.js`. It's ordered
most-specific to least-specific (first match wins, and it's what's shown on
the badge), and one entry is deliberately guarded — `\bexpo\b(?!\s*city)` —
so "Expo City" (a Dubai place name) doesn't get mistaken for an event
mention. Add your own patterns the same way if you notice a competitor using
event language this list doesn't catch yet.

## Customizing

- **Competitor chips**: edit the `PRESETS` array near the top of the
  `<script>` in `public/index.html`.
- **Analysis prompt**: edit `buildPrompt()` in `netlify/functions/analyze.js`.
- **Fields captured per ad**: edit the object built inside
  `extractAdsFromHtml()` in `netlify/functions/fetch-ads.js` — the parsed
  Meta payload also carries page like-count, page profile picture, link
  descriptions and more if you want to surface additional fields.
