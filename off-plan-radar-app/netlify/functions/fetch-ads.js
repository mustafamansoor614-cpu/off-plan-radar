// netlify/functions/fetch-ads.js
//
// Fetches live ad data for one advertiser/keyword from Meta's PUBLIC Ad Library
// (facebook.com/ads/library). No login, no official API — this reads the same
// public page a browser would, and pulls the ad data out of the JSON that Meta
// embeds directly in the page's HTML.
//
// Important, read this: this relies on the internal shape of a page Meta does
// not document or version. It can change or get rate-limited without warning.
// This is a personal research tool, not a product to resell or run at scale —
// see the README for the full explanation.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const COMMON_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(statusCode, body) {
  return { statusCode, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// --- cookie handling -------------------------------------------------------
// Meta refuses fully anonymous requests to the Ad Library. A quick visit to
// the homepage first earns the same guest cookies a real browser would pick
// up, which is enough to view public library results.

function extractSetCookies(res) {
  if (typeof res.headers.getSetCookie === "function") {
    const c = res.headers.getSetCookie();
    if (c && c.length) return c;
  }
  const raw = res.headers.get("set-cookie");
  return raw ? [raw] : [];
}

function cookieHeaderFrom(setCookieArr) {
  return setCookieArr
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function getGuestCookieHeader() {
  const res = await fetch("https://www.facebook.com/", { headers: COMMON_HEADERS });
  // Drain the body so the connection can be reused; we only need the cookies.
  await res.text();
  return cookieHeaderFrom(extractSetCookies(res));
}

// --- building the search request -------------------------------------------

function buildSearchUrl(query, country) {
  const params = new URLSearchParams({
    active_status: "active",
    ad_type: "all",
    country,
    media_type: "all",
    q: query,
    search_type: "keyword_unordered",
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

// --- classifying: roadshow / in-person event vs. plain lead-gen ------------
// Keyword/phrase patterns that signal an ad is promoting a physical event —
// a roadshow, a property expo, a "we're coming to your city" push — rather
// than a standard always-on lead-gen ad. First match wins; order roughly
// most-specific to least-specific so the label shown is the most useful one.

const EVENT_PATTERNS = [
  { label: "roadshow", re: /road[\s-]?show/i },
  { label: "property expo", re: /(property|real\s+estate)\s+expo/i },
  { label: "expo", re: /\bexpo\b(?!\s*city)/i }, // "Expo City" is a place name, not an event
  { label: "exhibition", re: /exhibition/i },
  { label: "open house", re: /open\s+house/i },
  { label: "sales event", re: /sales\s+event/i },
  { label: "launch event", re: /(pre-?launch|launch)\s+event/i },
  { label: "we're coming to your city", re: /(we('|’)?re|we\s+are)\s+(coming|visiting)\s+to(\s+your\s+city)?/i },
  { label: "meet us", re: /meet\s+(us|our\s+team|the\s+team|representatives)/i },
  { label: "join us", re: /join\s+us\s+(on|at|for)/i },
  { label: "save the date", re: /save\s+the\s+date/i },
  { label: "city tour", re: /city\s+tour/i },
  { label: "attendees", re: /\battendees\b/i },
  { label: "pop-up event", re: /pop-?up\s+(event|exhibition)/i },
  { label: "seminar", re: /\bseminar\b/i },
];

function classifyAd(ad) {
  const text = `${ad.title || ""} ${ad.body || ""}`;
  for (const { label, re } of EVENT_PATTERNS) {
    if (re.test(text)) return { category: "event", eventKeyword: label };
  }
  return { category: "leadgen", eventKeyword: null };
}

// --- pulling ads out of the HTML --------------------------------------------
// Meta server-renders the first batch of results as embedded JSON inside
// <script type="application/json" ...> blocks (their "BigPipe" pattern). We
// scan every such block for the one holding the search results connection.

function extractAdsFromHtml(html) {
  const blocks = [];
  const re = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);

  let totalCount = null;
  const ads = [];
  const seen = new Set();

  for (const block of blocks) {
    let obj;
    try {
      obj = JSON.parse(block);
    } catch {
      continue;
    }
    const conn = obj?.data?.ad_library_main?.search_results_connection;
    if (!conn) continue;

    if (typeof conn.count === "number") totalCount = conn.count;

    for (const edge of conn.edges || []) {
      const collated = edge?.node?.collated_results;
      if (!Array.isArray(collated)) continue;

      for (const item of collated) {
        if (!item?.ad_archive_id || seen.has(item.ad_archive_id)) continue;
        seen.add(item.ad_archive_id);

        const snap = item.snapshot || {};
        const video = Array.isArray(snap.videos) && snap.videos[0] ? snap.videos[0] : null;
        const image = Array.isArray(snap.images) && snap.images[0] ? snap.images[0] : null;

        const ad = {
          id: item.ad_archive_id,
          pageName: snap.page_name || item.page_name || "Unknown",
          isActive: !!item.is_active,
          startDate: item.start_date ? item.start_date * 1000 : null,
          endDate: item.end_date ? item.end_date * 1000 : null,
          platforms: item.publisher_platform || [],
          ctaText: snap.cta_text || null,
          ctaType: snap.cta_type || null,
          linkUrl: snap.link_url || null,
          title: snap.title || null,
          body: snap.body?.text || "",
          format: snap.display_format || null,
          thumbnail: video ? video.video_preview_image_url : image ? image.resized_image_url || image.original_image_url : null,
          isVideo: !!video,
          variantCount: item.collation_count || 1,
        };
        const { category, eventKeyword } = classifyAd(ad);
        ad.category = category; // "event" | "leadgen"
        ad.eventKeyword = eventKeyword; // which phrase triggered "event", if any

        ads.push(ad);
      }
    }
  }

  return { totalCount, ads };
}

// --- handler -----------------------------------------------------------------

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  try {
    const query = (event.queryStringParameters?.q || "").trim();
    const country = (event.queryStringParameters?.country || "AE").trim().toUpperCase();

    if (!query) return json(400, { error: "Missing competitor name (?q=...)." });
    if (!/^[A-Z]{2}$/.test(country)) return json(400, { error: "Country must be a 2-letter code, e.g. AE, US, GB." });

    const cookieHeader = await getGuestCookieHeader();
    const url = buildSearchUrl(query, country);

    const res = await fetch(url, { headers: { ...COMMON_HEADERS, Cookie: cookieHeader } });
    const html = await res.text();

    if (html.includes('"xfb_ad_library_is_captcha_required":true')) {
      return json(503, { error: "Meta is asking for a CAPTCHA on this request right now. Wait a minute and try again." });
    }
    if (res.status !== 200) {
      return json(502, { error: `Meta returned HTTP ${res.status}. It may be rate-limiting this server — try again shortly.` });
    }

    const { totalCount, ads } = extractAdsFromHtml(html);

    if (ads.length === 0) {
      return json(200, {
        query,
        country,
        totalCount: totalCount || 0,
        ads: [],
        warning:
          "No ads could be parsed. Either there really are no active ads for this search, or Meta changed the page's internal format and the parser needs updating.",
      });
    }

    return json(200, { query, country, totalCount, ads: ads.slice(0, 40) });
  } catch (err) {
    return json(500, { error: "Fetch failed: " + (err?.message || String(err)) });
  }
};
