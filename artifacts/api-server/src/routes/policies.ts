import { Router, type IRouter } from "express";
import * as cheerio from "cheerio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ExtractPoliciesBody } from "@workspace/api-zod";

const router: IRouter = Router();

function getGeminiClient(): GoogleGenerativeAI {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY environment variable is not set");
  return new GoogleGenerativeAI(apiKey);
}

// ─── User Agents ────────────────────────────────────────────────────────────
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
];

function buildBrowserHeaders(ua: string, origin?: string): Record<string, string> {
  const isBot = ua.includes("bot");
  const h: Record<string, string> = {
    "User-Agent": ua,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "en-GB,en;q=0.9,en-US;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "DNT": "1",
  };
  if (!isBot) {
    Object.assign(h, {
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": origin ? "same-origin" : "none",
      "Sec-Fetch-User": "?1",
      "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
    });
  }
  if (origin) h["Referer"] = origin;
  return h;
}

// ─── Fetch Strategies ────────────────────────────────────────────────────────

interface FetchResult {
  text: string;      // Clean text content
  source: string;    // Which strategy succeeded
  finalUrl: string;
}

/** Strategy 1: Jina AI Reader — renders JS, bypasses most bot protection */
async function fetchViaJina(url: string): Promise<FetchResult> {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const res = await fetch(jinaUrl, {
    headers: {
      "User-Agent": USER_AGENTS[0],
      "Accept": "text/plain,text/html,*/*",
      "X-Return-Format": "text",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Jina HTTP ${res.status}`);
  const text = await res.text();
  if (text.length < 100) throw new Error("Jina returned empty content");
  return { text, source: "jina", finalUrl: url };
}

/** Strategy 2: Direct fetch with rotating User-Agents */
async function fetchDirect(url: string): Promise<FetchResult> {
  const errors: string[] = [];
  for (let i = 0; i < USER_AGENTS.length; i++) {
    try {
      const res = await fetch(url, {
        headers: buildBrowserHeaders(USER_AGENTS[i]),
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const html = await res.text();
        return { text: extractTextFromHtml(html), source: `direct-ua${i}`, finalUrl: res.url || url };
      }
      errors.push(`UA${i}:${res.status}`);
      if (res.status === 404 || res.status >= 500) break;
      if (i < USER_AGENTS.length - 1) await delay(400 + i * 200);
    } catch (e) {
      errors.push(`UA${i}:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`Direct fetch failed: ${errors.join(", ")}`);
}

/** Strategy 3: Google Web Cache */
async function fetchGoogleCache(url: string): Promise<FetchResult> {
  const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}&hl=en`;
  const res = await fetch(cacheUrl, {
    headers: buildBrowserHeaders(USER_AGENTS[0]),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Google cache HTTP ${res.status}`);
  const html = await res.text();
  const text = extractTextFromHtml(html);
  if (text.length < 100) throw new Error("Google cache returned empty content");
  return { text, source: "google-cache", finalUrl: url };
}

/** Strategy 4: Wayback Machine (Internet Archive) */
async function fetchWayback(url: string): Promise<FetchResult> {
  // Find most recent snapshot
  const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const apiRes = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) });
  if (!apiRes.ok) throw new Error("Wayback API unavailable");
  const data = await apiRes.json() as { archived_snapshots?: { closest?: { url?: string; available?: boolean } } };
  const snapshotUrl = data?.archived_snapshots?.closest?.url;
  if (!snapshotUrl || !data?.archived_snapshots?.closest?.available) {
    throw new Error("No Wayback snapshot available");
  }
  const res = await fetch(snapshotUrl, {
    headers: buildBrowserHeaders(USER_AGENTS[0]),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Wayback fetch HTTP ${res.status}`);
  const html = await res.text();
  const text = extractTextFromHtml(html);
  if (text.length < 100) throw new Error("Wayback returned empty content");
  return { text, source: "wayback", finalUrl: snapshotUrl };
}

/** Strategy 5: Bing search cache via Jina */
async function fetchViaBingJina(url: string): Promise<FetchResult> {
  const bingCacheUrl = `https://cc.bingj.com/cache.aspx?q=${encodeURIComponent(url)}&url=${encodeURIComponent(url)}`;
  const jinaUrl = `https://r.jina.ai/${bingCacheUrl}`;
  const res = await fetch(jinaUrl, {
    headers: { "User-Agent": USER_AGENTS[0], "Accept": "text/plain,*/*" },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Bing+Jina HTTP ${res.status}`);
  const text = await res.text();
  if (text.length < 100) throw new Error("Bing+Jina returned empty content");
  return { text, source: "bing-jina", finalUrl: url };
}

/** Run all strategies in parallel, return first success */
async function fetchRobust(url: string, log: ReqLog): Promise<FetchResult> {
  log.info({ url }, "Starting robust fetch across all strategies");

  // Try Jina first (fastest and most reliable for JS-rendered sites)
  try {
    const r = await fetchViaJina(url);
    log.info({ url, source: r.source, len: r.text.length }, "Fetch succeeded");
    return r;
  } catch (e) {
    log.warn({ url, err: String(e) }, "Jina failed, trying parallel strategies");
  }

  // Try remaining strategies in parallel, take first winner
  const results = await Promise.allSettled([
    fetchDirect(url),
    fetchGoogleCache(url),
    fetchWayback(url),
    fetchViaBingJina(url),
  ]);

  for (const r of results) {
    if (r.status === "fulfilled" && r.value.text.length > 100) {
      log.info({ url, source: r.value.source, len: r.value.text.length }, "Fetch succeeded via fallback");
      return r.value;
    }
  }

  const errors = results.map((r) => r.status === "rejected" ? r.reason : "empty");
  throw new Error(`All fetch strategies failed for ${url}. Errors: ${errors.join(" | ")}`);
}

// ─── HTML/Text Utilities ─────────────────────────────────────────────────────

function extractTextFromHtml(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, iframe, svg, [role='navigation'], [role='banner'], header, footer, nav").remove();
  const selectors = ["main", "article", "#content", "#main", ".content", ".main", ".page-content", "body"];
  for (const sel of selectors) {
    const el = $(sel);
    if (el.length && el.text().trim().length > 200) {
      return el.text().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    }
  }
  return $("body").text().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function findPolicyLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const policyKeywords = [
    "cancellation", "cancel", "policy", "policies", "terms", "conditions",
    "booking", "payment", "refund", "deposit", "faq", "faqs", "help",
    "deferral", "visa", "guarantor", "fees",
  ];
  const links = new Set<string>();
  $("a[href]").each((_: number, el: cheerio.Element) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const full = new URL(href, baseUrl);
      if (full.origin !== base.origin) return;
      if (full.pathname.match(/\.(jpg|jpeg|png|gif|pdf|doc|docx|zip|css|js|ico|svg|xml|json|mp4|webp)$/i)) return;
      if (full.pathname === base.pathname) return;
      const txt = ($(el).text() || "").toLowerCase();
      const urlL = full.pathname.toLowerCase();
      if (policyKeywords.some((kw) => txt.includes(kw) || urlL.includes(kw))) {
        full.hash = "";
        links.add(full.href);
      }
    } catch { /* skip */ }
  });
  return Array.from(links).slice(0, 6);
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Types ───────────────────────────────────────────────────────────────────
type ReqLog = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

// ─── Gemini Prompt ───────────────────────────────────────────────────────────
const EXTRACTION_PROMPT = `You are a policy extraction specialist for student accommodation and housing websites.
Analyze the following web page content and extract specific policy information.

Return a JSON object with exactly this structure (use null for any policy not found or not mentioned):
{
  "cancellationPolicies": {
    "coolingOffPeriod": "detailed description or null",
    "noVisaNoPay": "detailed description or null",
    "noPlaceNoPay": "detailed description or null",
    "universityCourseModification": "detailed description or null",
    "earlyTermination": "detailed description or null",
    "delayedArrivals": "detailed description or null",
    "replacementTenant": "detailed description or null",
    "deferringStudies": "detailed description or null",
    "universityIntakeDelayed": "detailed description or null",
    "noQuestionsAsked": "detailed description or null",
    "extenuatingCircumstances": "detailed description or null",
    "other": "any other cancellation policies not covered above, or null"
  },
  "paymentPolicies": {
    "bookingDeposit": "detailed description or null",
    "securityDeposit": "detailed description or null",
    "paymentInstalmentPlan": "detailed description or null",
    "modeOfPayment": "detailed description or null",
    "guarantorRequirement": "detailed description or null",
    "additionalFees": "detailed description or null"
  }
}

Policy definitions:
- coolingOffPeriod: Period after signing where tenant can cancel without penalty
- noVisaNoPay: Policy if student cannot get a visa
- noPlaceNoPay: Policy if student does not get a university place
- universityCourseModification: Policy if course is changed/modified/cancelled by university
- earlyTermination: Policy for students ending tenancy early
- delayedArrivals: Policy for students arriving late or with travel restrictions
- replacementTenant: Policy about finding a replacement tenant to cancel
- deferringStudies: Policy for students deferring their university studies
- universityIntakeDelayed: Policy if university delays its intake/semester start
- noQuestionsAsked: Unconditional cancellation option (usually within specific timeframe)
- extenuatingCircumstances: Special circumstances cancellation (medical, family emergencies, etc.)
- bookingDeposit: Deposit required at booking, amount, refund conditions
- securityDeposit: Security/damage deposit details
- paymentInstalmentPlan: Instalment/installment payment options available
- modeOfPayment: Accepted payment methods
- guarantorRequirement: Whether a guarantor is needed and requirements
- additionalFees: Any extra fees, admin fees, late payment fees, etc.

Important: Only include information explicitly stated in the text. Do not infer or assume. Be detailed and include specific amounts, timeframes, and conditions when mentioned. Return ONLY valid JSON, no markdown.

Web content to analyze:
`;

// ─── Route ───────────────────────────────────────────────────────────────────
router.post("/extract-policies", async (req, res): Promise<void> => {
  const parsed = ExtractPoliciesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { url } = parsed.data;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      res.status(400).json({ error: "URL must use http or https protocol" });
      return;
    }
  } catch {
    res.status(400).json({ error: "Invalid URL provided" });
    return;
  }

  const log: ReqLog = req.log;
  log.info({ url }, "Starting policy extraction");

  const pagesVisited: string[] = [];
  const allChunks: string[] = [];

  try {
    // ── Step 1: Fetch main URL using all available strategies ────────────────
    let mainResult: FetchResult;
    try {
      mainResult = await fetchRobust(url, log);
      pagesVisited.push(mainResult.finalUrl);
      allChunks.push(`=== PAGE: ${mainResult.finalUrl} ===\n${mainResult.text}`);
    } catch (mainErr) {
      // If main page fails, try root domain
      const rootUrl = `${parsedUrl.protocol}//${parsedUrl.host}/`;
      if (rootUrl !== url) {
        log.warn({ url, err: String(mainErr) }, "Main URL failed, trying root domain");
        try {
          mainResult = await fetchRobust(rootUrl, log);
          pagesVisited.push(mainResult.finalUrl);
          allChunks.push(`=== PAGE: ${mainResult.finalUrl} ===\n${mainResult.text}`);
        } catch (rootErr) {
          res.status(500).json({
            error: `Unable to access this website through any method. Even the homepage (${rootUrl}) could not be reached. Please check the URL and try again.`,
          });
          return;
        }
      } else {
        res.status(500).json({ error: `Unable to access ${url} through any method. Please check the URL and try again.` });
        return;
      }
    }

    // ── Step 2: Discover policy sub-pages from the fetched HTML ──────────────
    // For Jina/text results we may not have HTML — re-fetch HTML for link discovery
    let htmlForLinks: string | null = null;
    try {
      const directRes = await fetch(url, {
        headers: buildBrowserHeaders(USER_AGENTS[5]), // Googlebot
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
      if (directRes.ok) htmlForLinks = await directRes.text();
    } catch { /* ignore, we'll try without link discovery */ }

    if (htmlForLinks) {
      const effectiveBase = pagesVisited[0] ?? url;
      const policyLinks = findPolicyLinks(htmlForLinks, effectiveBase);
      log.info({ policyLinks }, "Discovered policy sub-pages");

      await Promise.allSettled(
        policyLinks
          .filter((l) => !pagesVisited.includes(l))
          .map(async (link) => {
            try {
              const r = await fetchRobust(link, log);
              if (r.text.length > 100) {
                allChunks.push(`=== PAGE: ${r.finalUrl} ===\n${r.text}`);
                pagesVisited.push(r.finalUrl);
              }
            } catch (e) {
              log.warn({ link, err: String(e) }, "Sub-page fetch failed");
            }
          })
      );
    }

    if (allChunks.length === 0) {
      res.status(500).json({ error: "Could not extract any content from this site." });
      return;
    }

    // ── Step 3: Gemini AI extraction ─────────────────────────────────────────
    const combinedText = allChunks.join("\n\n").slice(0, 60000);

    const genAI = getGeminiClient();

    // Try models in priority order — falls back automatically if one is unavailable
    const MODEL_PRIORITY = [
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
    ];

    let responseText = "";
    let lastModelError: Error | null = null;

    for (const modelName of MODEL_PRIORITY) {
      try {
        log.info({ modelName }, "Trying Gemini model");
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(EXTRACTION_PROMPT + combinedText);
        responseText = result.response.text().trim();
        log.info({ modelName }, "Gemini extraction succeeded");
        break;
      } catch (modelErr) {
        lastModelError = modelErr instanceof Error ? modelErr : new Error(String(modelErr));
        log.warn({ modelName, err: lastModelError.message }, "Model failed, trying next");
      }
    }

    if (!responseText) {
      log.error({ err: lastModelError?.message }, "All Gemini models failed");
      res.status(500).json({ error: `AI extraction failed: ${lastModelError?.message ?? "unknown error"}` });
      return;
    }

    let policies: {
      cancellationPolicies: Record<string, string | null>;
      paymentPolicies: Record<string, string | null>;
    };
    try {
      const cleaned = responseText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      policies = JSON.parse(cleaned);
    } catch {
      log.error({ responseText }, "Failed to parse Gemini JSON");
      res.status(500).json({ error: "AI returned an unexpected format. Please try again." });
      return;
    }

    res.json({
      url,
      pagesVisited,
      cancellationPolicies: policies.cancellationPolicies ?? {},
      paymentPolicies: policies.paymentPolicies ?? {},
      extractedAt: new Date().toISOString(),
      rawText: null,
    });

    log.info({ url, pages: pagesVisited.length }, "Policy extraction complete");
  } catch (err: unknown) {
    log.error({ err, url }, "Policy extraction failed unexpectedly");
    res.status(500).json({ error: err instanceof Error ? err.message : "Extraction failed" });
  }
});

export default router;
