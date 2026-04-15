import { Router, type IRouter } from "express";
import * as cheerio from "cheerio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ExtractPoliciesBody } from "@workspace/api-zod";

const router: IRouter = Router();

function getGeminiClients(): GoogleGenerativeAI[] {
  const keys = [
    process.env.GOOGLE_API_KEY,
    process.env.GOOGLE_API_KEY_2,
  ].filter((k): k is string => typeof k === "string" && k.trim().length > 0);

  if (keys.length === 0) throw new Error("No GOOGLE_API_KEY environment variable is set");
  return keys.map((k) => new GoogleGenerativeAI(k));
}

// ─── User Agents ─────────────────────────────────────────────────────────────
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

// ─── Types ───────────────────────────────────────────────────────────────────
type ReqLog = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

interface FetchResult {
  text: string;
  html: string;
  source: string;
  finalUrl: string;
}

type PolicyMap = Record<string, string | null>;
interface ExtractedPolicies {
  cancellationPolicies: PolicyMap;
  paymentPolicies: PolicyMap;
}

// ─── Fetch Strategies ────────────────────────────────────────────────────────

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
  return { text, html: text, source: "jina", finalUrl: url };
}

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
        return { text: extractTextFromHtml(html), html, source: `direct-ua${i}`, finalUrl: res.url || url };
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
  return { text, html, source: "google-cache", finalUrl: url };
}

async function fetchWayback(url: string): Promise<FetchResult> {
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
  return { text, html, source: "wayback", finalUrl: snapshotUrl };
}

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
  return { text, html: text, source: "bing-jina", finalUrl: url };
}

async function fetchRobust(url: string, log: ReqLog): Promise<FetchResult> {
  log.info({ url }, "Fetching page");

  try {
    const r = await fetchViaJina(url);
    log.info({ url, source: r.source, len: r.text.length }, "Fetch succeeded via Jina");
    return r;
  } catch (e) {
    log.warn({ url, err: String(e) }, "Jina failed, trying parallel strategies");
  }

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

  const errors = results.map((r) => r.status === "rejected" ? String(r.reason) : "empty");
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

/**
 * Extract internal links with smart prioritization:
 * 1. Policy/terms/faq pages get top priority
 * 2. Navigation/info pages second
 * 3. Other internal pages fill the remainder
 * Returns up to `limit` links total.
 */
function findAllInternalLinks(html: string, baseUrl: string, limit = 20): string[] {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);

  const SKIP_PATTERNS = /\.(jpg|jpeg|png|gif|pdf|doc|docx|zip|css|js|ico|svg|xml|json|mp4|webp|woff|woff2|ttf|eot)$/i;
  const SKIP_PATHS = /\/(login|logout|signup|register|cart|checkout|account|auth|cdn-cgi|wp-admin|wp-json|api\/|sitemap|robots\.txt)/i;

  // Policy-related keywords — highest priority
  const POLICY_KEYWORDS = [
    "cancellation", "cancel", "policy", "policies", "terms", "conditions",
    "booking", "payment", "refund", "deposit", "faq", "faqs", "help",
    "deferral", "visa", "guarantor", "fees", "charges", "instalment",
    "installment", "cooling", "tenancy", "agreement", "legal", "contract",
  ];

  // Navigation/info keywords — medium priority
  const INFO_KEYWORDS = [
    "about", "how", "info", "guide", "student", "living", "support",
    "contact", "services", "facilities", "amenities",
  ];

  const highPriority = new Set<string>();
  const medPriority = new Set<string>();
  const lowPriority = new Set<string>();

  $("a[href]").each((_: number, el: cheerio.Element) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    try {
      const full = new URL(href, baseUrl);
      if (full.origin !== base.origin) return;
      if (full.pathname === base.pathname) return;
      if (SKIP_PATTERNS.test(full.pathname)) return;
      if (SKIP_PATHS.test(full.pathname)) return;
      full.hash = "";
      full.search = "";
      const linkText = ($(el).text() || "").toLowerCase();
      const pathL = full.pathname.toLowerCase();
      const combined = linkText + " " + pathL;

      if (POLICY_KEYWORDS.some((kw) => combined.includes(kw))) {
        highPriority.add(full.href);
      } else if (INFO_KEYWORDS.some((kw) => combined.includes(kw))) {
        medPriority.add(full.href);
      } else {
        lowPriority.add(full.href);
      }
    } catch { /* skip */ }
  });

  // Combine: policy pages first, then info pages, then others
  const ordered = [
    ...Array.from(highPriority),
    ...Array.from(medPriority).filter((l) => !highPriority.has(l)),
    ...Array.from(lowPriority).filter((l) => !highPriority.has(l) && !medPriority.has(l)),
  ];

  return ordered.slice(0, limit);
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Smart policy-relevant text extraction ────────────────────────────────────
// Instead of sending entire pages, score paragraphs by policy keyword density
// and send only the highest-relevance content to Gemini.

const MAX_COMBINED_CHARS = 50000; // hard cap — keeps usage to 1 Gemini call
const MAX_CHARS_PER_PAGE = 8000;  // max chars we take from any single page

const POLICY_SCORE_KEYWORDS = [
  // High-weight terms (cancellation/payment policy vocabulary)
  "cancellation", "cancel", "refund", "cooling off", "cooling-off",
  "no visa", "no place", "no pay", "visa", "deferr", "defer",
  "early termination", "terminate", "replacement tenant", "booking fee",
  "security deposit", "damage deposit", "instalment", "installment",
  "payment plan", "guarantor", "booking deposit", "admin fee",
  "extenuating", "circumstances", "bereavement", "medical",
  "delayed arrival", "intake", "university place",
  // Medium-weight terms
  "policy", "policies", "terms", "conditions", "clause",
  "deposit", "payment", "fee", "charge", "penalty",
  "tenancy", "agreement", "contract", "booking",
];

/**
 * Score a paragraph by its policy-relevance (higher = more relevant).
 */
function scoreParagraph(para: string): number {
  const lower = para.toLowerCase();
  let score = 0;
  for (const kw of POLICY_SCORE_KEYWORDS) {
    if (lower.includes(kw)) score += kw.length > 8 ? 3 : 1;
  }
  return score;
}

/**
 * Extract only the most policy-relevant paragraphs from page text.
 * Takes paragraphs in score order until `maxChars` is reached.
 */
function extractRelevantText(pageText: string, maxChars = MAX_CHARS_PER_PAGE): string {
  const paragraphs = pageText.split(/\n{2,}/).filter((p) => p.trim().length > 30);

  // Score each paragraph
  const scored = paragraphs.map((p) => ({ text: p.trim(), score: scoreParagraph(p) }));

  // Sort by score descending, then keep document order for top ones
  // Strategy: take all high-score paragraphs first, then pad with more if space allows
  const highScore = scored.filter((p) => p.score > 0).sort((a, b) => b.score - a.score);
  const noScore = scored.filter((p) => p.score === 0);

  const selected: string[] = [];
  let totalChars = 0;

  for (const p of [...highScore, ...noScore]) {
    if (totalChars + p.text.length > maxChars) break;
    selected.push(p.text);
    totalChars += p.text.length;
  }

  return selected.join("\n\n");
}

// Fallback split if combined is somehow still large (rare)
const MAX_CHUNK_CHARS = 48000;

function splitForFallback(text: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + MAX_CHUNK_CHARS));
    i += MAX_CHUNK_CHARS;
  }
  return chunks;
}

// ─── Gemini Prompt ────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are extracting policy information from a student accommodation website page chunk.

CRITICAL RULES — read carefully:
1. Extract ONLY text that is EXPLICITLY written on this page. Copy the EXACT wording from the source.
2. Do NOT paraphrase, summarize, rewrite, or add any information not present in this chunk.
3. Do NOT infer, guess, or assume any policy from general context. Null means not found.
4. If a policy IS found, include the complete verbatim passage (including all specific amounts, timeframes, percentages, and conditions stated).
5. Return null for any policy not explicitly mentioned in this chunk.
6. Return ONLY valid JSON — no markdown, no code blocks, no commentary.

Return this exact JSON structure:
{
  "cancellationPolicies": {
    "coolingOffPeriod": "<exact verbatim text from page, or null>",
    "noVisaNoPay": "<exact verbatim text from page, or null>",
    "noPlaceNoPay": "<exact verbatim text from page, or null>",
    "universityCourseModification": "<exact verbatim text from page, or null>",
    "earlyTermination": "<exact verbatim text from page, or null>",
    "delayedArrivals": "<exact verbatim text from page, or null>",
    "replacementTenant": "<exact verbatim text from page, or null>",
    "deferringStudies": "<exact verbatim text from page, or null>",
    "universityIntakeDelayed": "<exact verbatim text from page, or null>",
    "noQuestionsAsked": "<exact verbatim text from page, or null>",
    "extenuatingCircumstances": "<exact verbatim text from page, or null>",
    "other": "<exact verbatim text for any other cancellation policy not listed above, or null>"
  },
  "paymentPolicies": {
    "bookingDeposit": "<exact verbatim text from page, or null>",
    "securityDeposit": "<exact verbatim text from page, or null>",
    "paymentInstalmentPlan": "<exact verbatim text from page, or null>",
    "modeOfPayment": "<exact verbatim text from page, or null>",
    "guarantorRequirement": "<exact verbatim text from page, or null>",
    "additionalFees": "<exact verbatim text from page, or null>"
  }
}

Policy definitions (use these ONLY to identify which category to assign found text to):
- coolingOffPeriod: Period after booking/signing where tenant can cancel without penalty
- noVisaNoPay: Policy if student cannot obtain a visa
- noPlaceNoPay: Policy if student does not get a university place
- universityCourseModification: Policy if course is changed/modified/cancelled by the university
- earlyTermination: Policy for ending tenancy before the contract end date
- delayedArrivals: Policy for students arriving late or with travel restrictions
- replacementTenant: Policy about finding or providing a replacement tenant to exit early
- deferringStudies: Policy for students deferring their university studies
- universityIntakeDelayed: Policy if university delays its intake/semester start
- noQuestionsAsked: Unconditional cancellation option within a specific timeframe
- extenuatingCircumstances: Cancellation for special circumstances (medical, bereavement, etc.)
- bookingDeposit: Amount and conditions of deposit required at booking
- securityDeposit: Security/damage deposit details
- paymentInstalmentPlan: Instalment or installment payment schedule options
- modeOfPayment: Accepted payment methods
- guarantorRequirement: Guarantor requirements and criteria
- additionalFees: Admin fees, late payment fees, or any other extra charges

Page chunk to analyze:
`;

// ─── Merge Partial Extractions ────────────────────────────────────────────────

function mergeExtractions(results: ExtractedPolicies[]): ExtractedPolicies {
  const merged: ExtractedPolicies = {
    cancellationPolicies: {
      coolingOffPeriod: null,
      noVisaNoPay: null,
      noPlaceNoPay: null,
      universityCourseModification: null,
      earlyTermination: null,
      delayedArrivals: null,
      replacementTenant: null,
      deferringStudies: null,
      universityIntakeDelayed: null,
      noQuestionsAsked: null,
      extenuatingCircumstances: null,
      other: null,
    },
    paymentPolicies: {
      bookingDeposit: null,
      securityDeposit: null,
      paymentInstalmentPlan: null,
      modeOfPayment: null,
      guarantorRequirement: null,
      additionalFees: null,
    },
  };

  for (const result of results) {
    for (const key of Object.keys(merged.cancellationPolicies)) {
      if (!merged.cancellationPolicies[key] && result.cancellationPolicies?.[key]) {
        merged.cancellationPolicies[key] = result.cancellationPolicies[key];
      }
    }
    for (const key of Object.keys(merged.paymentPolicies)) {
      if (!merged.paymentPolicies[key] && result.paymentPolicies?.[key]) {
        merged.paymentPolicies[key] = result.paymentPolicies[key];
      }
    }
  }

  return merged;
}

// ─── Gemini extraction ────────────────────────────────────────────────────────

// Models in priority order — best/newest first
const MODEL_PRIORITY = [
  "gemini-2.5-flash",       // Gemini 2.5 Flash — primary
  "gemini-3-flash-preview", // Gemini 3 Flash — next best
  "gemini-2.5-flash-lite",  // Gemini 2.5 Flash Lite — lightweight fallback
];

/**
 * Try content extraction across all (key × model) combinations.
 * Strategy: for each model, try every key before falling to the next model.
 * This maximises quota across both keys before degrading model quality.
 *
 * Attempt order (2 keys × 3 models = 6 combinations):
 *   key1 + gemini-2.5-flash
 *   key2 + gemini-2.5-flash
 *   key1 + gemini-3-flash-preview
 *   key2 + gemini-3-flash-preview
 *   key1 + gemini-2.5-flash-lite
 *   key2 + gemini-2.5-flash-lite
 */
async function callGemini(
  clients: GoogleGenerativeAI[],
  content: string,
  label: string,
  log: ReqLog
): Promise<ExtractedPolicies | null | "quota"> {
  let responseText = "";
  let lastErr: Error | null = null;
  let allQuota = true; // assume quota until we see a non-quota failure

  outer:
  for (const modelName of MODEL_PRIORITY) {
    for (let ki = 0; ki < clients.length; ki++) {
      try {
        log.info({ modelName, keyIndex: ki + 1, label, chars: content.length }, "Calling Gemini");
        const model = clients[ki].getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
          },
        });
        const result = await model.generateContent(EXTRACTION_PROMPT + content);
        responseText = result.response.text().trim();
        log.info({ modelName, keyIndex: ki + 1, label }, "Gemini call succeeded");
        break outer; // success — stop trying
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        const isQuota = lastErr.message.includes("429") || lastErr.message.toLowerCase().includes("quota");
        if (!isQuota) allQuota = false;
        log.warn(
          { modelName, keyIndex: ki + 1, label, quota: isQuota, err: lastErr.message.slice(0, 200) },
          isQuota ? "Quota hit — trying next key/model" : "Model call failed — trying next"
        );
      }
    }
  }

  if (!responseText) {
    log.error({ label, err: lastErr?.message?.slice(0, 200) }, "All key+model combinations failed");
    if (allQuota) return "quota";
    return null;
  }

  try {
    const cleaned = responseText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    return JSON.parse(cleaned) as ExtractedPolicies;
  } catch {
    log.warn({ label, snippet: responseText.slice(0, 300) }, "Failed to parse Gemini JSON");
    return null;
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────
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

  // ── Phase 1: Fetch all pages ─────────────────────────────────────────────────

  interface PageData {
    url: string;
    text: string;
    html: string;
  }
  const pages: PageData[] = [];

  try {
    // 1a. Fetch main page
    let mainResult: FetchResult;
    try {
      mainResult = await fetchRobust(url, log);
    } catch (mainErr) {
      const rootUrl = `${parsedUrl.protocol}//${parsedUrl.host}/`;
      if (rootUrl !== url) {
        log.warn({ url, err: String(mainErr) }, "Main URL failed, trying root domain");
        try {
          mainResult = await fetchRobust(rootUrl, log);
        } catch {
          res.status(500).json({
            error: `Unable to access this website through any method. Please check the URL and try again.`,
          });
          return;
        }
      } else {
        res.status(500).json({ error: `Unable to access ${url}. Please check the URL and try again.` });
        return;
      }
    }

    pagesVisited.push(mainResult.finalUrl);
    pages.push({ url: mainResult.finalUrl, text: mainResult.text, html: mainResult.html });
    log.info({ url: mainResult.finalUrl, len: mainResult.text.length }, "Main page fetched");

    // 1b. Discover ALL internal links from the main page HTML
    // Re-fetch raw HTML for link discovery (Jina returns text, not HTML)
    let htmlForLinks = mainResult.html;
    if (mainResult.source === "jina") {
      // Try to get actual HTML for link discovery
      try {
        const directRes = await fetch(url, {
          headers: buildBrowserHeaders(USER_AGENTS[5]),
          redirect: "follow",
          signal: AbortSignal.timeout(15000),
        });
        if (directRes.ok) htmlForLinks = await directRes.text();
      } catch { /* use text content for link extraction */ }
    }

    const internalLinks = findAllInternalLinks(htmlForLinks, mainResult.finalUrl, 20);
    log.info({ count: internalLinks.length, links: internalLinks }, "Discovered internal links");

    // 1c. Fetch all internal links in parallel (max 15)
    const subResults = await Promise.allSettled(
      internalLinks
        .filter((l) => !pagesVisited.includes(l))
        .slice(0, 15)
        .map(async (link) => {
          try {
            const r = await fetchRobust(link, log);
            if (r.text.length > 150) {
              return { url: r.finalUrl, text: r.text, html: r.html };
            }
            return null;
          } catch (e) {
            log.warn({ link, err: String(e) }, "Sub-page fetch failed");
            return null;
          }
        })
    );

    for (const r of subResults) {
      if (r.status === "fulfilled" && r.value) {
        if (!pagesVisited.includes(r.value.url)) {
          pagesVisited.push(r.value.url);
          pages.push(r.value);
          log.info({ url: r.value.url, len: r.value.text.length }, "Sub-page fetched");
        }
      }
    }

    log.info({ totalPages: pages.length }, "All pages collected");
  } catch (err) {
    log.error({ err, url }, "Page collection failed unexpectedly");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch pages" });
    return;
  }

  if (pages.length === 0) {
    res.status(500).json({ error: "Could not retrieve any content from this site." });
    return;
  }

  // ── Phase 2: Build focused document from policy-relevant paragraphs ──────────
  // Each page is filtered to only include paragraphs containing policy keywords.
  // This dramatically reduces content size and keeps extraction within 1 Gemini call.

  const pageSegments: string[] = [];
  for (const page of pages) {
    const relevant = extractRelevantText(page.text, MAX_CHARS_PER_PAGE);
    if (relevant.trim().length > 50) {
      pageSegments.push(`=== SOURCE: ${page.url} ===\n${relevant}`);
    }
  }

  const combinedDocument = pageSegments.join("\n\n").slice(0, MAX_COMBINED_CHARS);

  log.info(
    { totalChars: combinedDocument.length, pages: pages.length, segments: pageSegments.length },
    "Policy-focused document built"
  );

  // ── Phase 3: Gemini extraction (single call, 2-chunk fallback if rare edge case) ──

  const clients = getGeminiClients();
  const allResults: ExtractedPolicies[] = [];
  let quotaHit = false;

  log.info({ keys: clients.length, models: MODEL_PRIORITY.length }, "Starting Gemini extraction");

  if (combinedDocument.length <= MAX_CHUNK_CHARS) {
    // Standard path: single call with all content
    const result = await callGemini(clients, combinedDocument, "full-document", log);
    if (result === "quota") { quotaHit = true; }
    else if (result) allResults.push(result);
  } else {
    // Fallback: content too large — split into 2 sequential calls with delay
    const fallbackChunks = splitForFallback(combinedDocument).slice(0, 2);
    log.info({ chunks: fallbackChunks.length }, "Document large — using 2-chunk sequential fallback");
    for (let i = 0; i < fallbackChunks.length; i++) {
      const result = await callGemini(clients, fallbackChunks[i], `chunk-${i + 1}-of-${fallbackChunks.length}`, log);
      if (result === "quota") { quotaHit = true; break; }
      else if (result) allResults.push(result);
      if (i < fallbackChunks.length - 1) await delay(7000);
    }
  }

  if (allResults.length === 0) {
    if (quotaHit) {
      res.status(429).json({
        error: "Your Google AI API key has reached its free tier daily request limit (20 requests/day for Gemini 2.5 Flash). The quota resets at midnight Pacific Time. Please try again tomorrow, or visit https://ai.google.dev to upgrade your API plan.",
      });
    } else {
      res.status(500).json({ error: "AI extraction failed — could not parse any policy data. Please try again." });
    }
    return;
  }

  // ── Phase 4: Merge results (first non-null value per policy wins) ─────────────

  const merged = mergeExtractions(allResults);

  log.info(
    {
      url,
      pages: pagesVisited.length,
      totalChars: combinedDocument.length,
      resultsAggregated: allResults.length,
    },
    "Policy extraction complete"
  );

  res.json({
    url,
    pagesVisited,
    cancellationPolicies: merged.cancellationPolicies,
    paymentPolicies: merged.paymentPolicies,
    extractedAt: new Date().toISOString(),
    rawText: null,
  });
});

export default router;
