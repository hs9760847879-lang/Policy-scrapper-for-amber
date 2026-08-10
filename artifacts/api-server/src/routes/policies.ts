import { Router, type IRouter } from "express";
import * as cheerio from "cheerio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ExtractPoliciesBody } from "@workspace/api-zod";

const router: IRouter = Router();

function getGeminiClients(): GoogleGenerativeAI[] {
  const keys = [
    process.env.GOOGLE_API_KEY,
    process.env.GOOGLE_API_KEY_2,
    process.env.GOOGLE_API_KEY_3,
    process.env.GOOGLE_API_KEY_4,
    process.env.GOOGLE_API_KEY_5,
    process.env.GOOGLE_API_KEY_6,
    process.env.GOOGLE_API_KEY_7,
  ].filter((k): k is string => typeof k === "string" && k.trim().length > 0);

  if (keys.length === 0)
    throw new Error("No GOOGLE_API_KEY environment variable is set");
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

function buildBrowserHeaders(
  ua: string,
  origin?: string,
): Record<string, string> {
  const isBot = ua.includes("bot");
  const h: Record<string, string> = {
    "User-Agent": ua,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "en-GB,en;q=0.9,en-US;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    DNT: "1",
  };
  if (!isBot) {
    Object.assign(h, {
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": origin ? "same-origin" : "none",
      "Sec-Fetch-User": "?1",
      "Sec-Ch-Ua":
        '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
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
  debug(obj: object, msg: string): void;
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
      Accept: "text/plain,text/html,*/*",
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
        return {
          text: extractTextFromHtml(html),
          html,
          source: `direct-ua${i}`,
          finalUrl: res.url || url,
        };
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
  const data = (await apiRes.json()) as {
    archived_snapshots?: { closest?: { url?: string; available?: boolean } };
  };
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
    headers: { "User-Agent": USER_AGENTS[0], Accept: "text/plain,*/*" },
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
    log.info(
      { url, source: r.source, len: r.text.length },
      "Fetch succeeded via Jina",
    );
    return r;
  } catch (e) {
    log.warn(
      { url, err: String(e) },
      "Jina failed, trying parallel strategies",
    );
  }

  const results = await Promise.allSettled([
    fetchDirect(url),
    fetchGoogleCache(url),
    fetchWayback(url),
    fetchViaBingJina(url),
  ]);

  for (const r of results) {
    if (r.status === "fulfilled" && r.value.text.length > 100) {
      log.info(
        { url, source: r.value.source, len: r.value.text.length },
        "Fetch succeeded via fallback",
      );
      return r.value;
    }
  }

  const errors = results.map((r) =>
    r.status === "rejected" ? String(r.reason) : "empty",
  );
  throw new Error(
    `All fetch strategies failed for ${url}. Errors: ${errors.join(" | ")}`,
  );
}

// ─── HTML/Text Utilities ─────────────────────────────────────────────────────

function extractTextFromHtml(html: string): string {
  const $ = cheerio.load(html);

  // Remove non-content elements
  $(
    "script, style, noscript, iframe, svg, [role='navigation'], [role='banner'], header, footer, nav, .cookie-banner, .cookie-consent",
  ).remove();

  // Force-reveal hidden accordion/collapse/tab content so it's included in text extraction.
  // Many sites use aria-hidden, display:none, or class-based hiding for their FAQ accordions.
  $("[aria-hidden='true']").attr("aria-hidden", "false");
  $("[hidden]").removeAttr("hidden");
  // Expand <details> elements (native HTML accordions)
  $("details").attr("open", "");
  // Force visibility on common accordion/tab panel classes
  $(
    ".accordion-content, .accordion-body, .accordion__content, .accordion__body, " +
      ".collapse, .collapsible-content, .panel-body, .tab-content, .tab-pane, " +
      ".faq-answer, .faq__answer, .faq-body, " +
      "[class*='accordion'][class*='content'], [class*='accordion'][class*='body'], " +
      "[class*='collapse'][class*='content'], [class*='panel'][class*='body']",
  ).css("display", "block");

  const selectors = [
    "main",
    "article",
    "#content",
    "#main",
    ".content",
    ".main",
    ".page-content",
    "body",
  ];
  for (const sel of selectors) {
    const el = $(sel);
    if (el.length && el.text().trim().length > 200) {
      return el
        .text()
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
  }
  return $("body")
    .text()
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract internal links with smart prioritization:
 * 1. Policy/terms/faq pages get top priority
 * 2. Navigation/info pages second
 * 3. Other internal pages fill the remainder
 * Returns up to `limit` links total.
 */
function findAllInternalLinks(
  html: string,
  baseUrl: string,
  limit = 20,
): string[] {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);

  const SKIP_PATTERNS =
    /\.(jpg|jpeg|png|gif|pdf|doc|docx|zip|css|js|ico|svg|xml|json|mp4|webp|woff|woff2|ttf|eot)$/i;
  const SKIP_PATHS =
    /\/(login|logout|signup|register|cart|checkout|account|auth|cdn-cgi|wp-admin|wp-json|api\/|sitemap|robots\.txt)/i;

  // Policy-related keywords — highest priority
  const POLICY_KEYWORDS = [
    "cancellation",
    "cancel",
    "policy",
    "policies",
    "terms",
    "conditions",
    "booking",
    "payment",
    "refund",
    "deposit",
    "faq",
    "faqs",
    "help",
    "deferral",
    "visa",
    "guarantor",
    "fees",
    "charges",
    "instalment",
    "installment",
    "cooling",
    "tenancy",
    "agreement",
    "legal",
    "contract",
  ];

  // Navigation/info keywords — medium priority
  const INFO_KEYWORDS = [
    "about",
    "how",
    "info",
    "guide",
    "student",
    "living",
    "support",
    "contact",
    "services",
    "facilities",
    "amenities",
  ];

  const highPriority = new Set<string>();
  const medPriority = new Set<string>();
  const lowPriority = new Set<string>();

  $("a[href]").each((_: number, el: any) => {
    const href = $(el).attr("href");
    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:")
    )
      return;
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
    } catch {
      /* skip */
    }
  });

  // Combine: policy pages first, then info pages, then others
  const ordered = [
    ...Array.from(highPriority),
    ...Array.from(medPriority).filter((l) => !highPriority.has(l)),
    ...Array.from(lowPriority).filter(
      (l) => !highPriority.has(l) && !medPriority.has(l),
    ),
  ];

  return ordered.slice(0, limit);
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Smart policy-relevant text extraction ────────────────────────────────────
// Instead of sending entire pages, score paragraphs by policy keyword density
// and send only the highest-relevance content to Gemini.

const MAX_COMBINED_CHARS = 52000; // hard cap — keeps usage to 1 Gemini call
const MAX_CHARS_PER_PAGE = 6000; // max chars we take from any single page
const MIN_PAGE_POLICY_CHARS = 150; // pages with fewer scored chars than this are excluded

const POLICY_SCORE_KEYWORDS = [
  // ── Cancellation policy vocabulary ───────────────────────────────────────
  "cancellation",
  "cancel",
  "refund",
  "cooling off",
  "cooling-off",
  "no visa",
  "no place",
  "no pay",
  "visa refusal",
  "visa refused",
  "deferr",
  "defer",
  "gap year",
  "postpone",
  "early termination",
  "terminate",
  "leave early",
  "break clause",
  "replacement tenant",
  "tenancy takeover",
  "subletting",
  "extenuating",
  "bereavement",
  "compassionate grounds",
  "serious illness",
  "delayed arrival",
  "travel restriction",
  "arrive later",
  "intake delayed",
  "semester delayed",
  "university postponed",
  "no questions asked",
  "cancel for any reason",
  "free cancellation",
  "course cancelled",
  "course changed",
  "course withdrawn",
  "university place",
  "exam results",
  "results day",
  "A-levels",
  // ── Payment policy vocabulary ─────────────────────────────────────────────
  "booking fee",
  "booking deposit",
  "reservation fee",
  "holding deposit",
  "security deposit",
  "damage deposit",
  "damage waiver",
  "bond",
  "returnable deposit",
  "non-refundable",
  "instalment",
  "installment",
  "payment plan",
  "monthly payment",
  "quarterly payment",
  "termly payment",
  "payment schedule",
  "guarantor",
  "uk guarantor",
  "guarantee your rent",
  "admin fee",
  "late payment fee",
  "room change fee",
  "cleaning fee",
  "bank transfer",
  "credit card",
  "debit card",
  "direct debit",
  "how to pay",
  "payment method",
  "accepted payment",
  // ── General policy terms ──────────────────────────────────────────────────
  "policy",
  "policies",
  "terms",
  "conditions",
  "clause",
  "deposit",
  "payment",
  "fee",
  "charge",
  "penalty",
  "tenancy",
  "agreement",
  "contract",
  "booking",
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
function extractRelevantText(
  pageText: string,
  maxChars = MAX_CHARS_PER_PAGE,
): string {
  const paragraphs = pageText
    .split(/\n{2,}/)
    .filter((p) => p.trim().length > 30);

  // Score each paragraph
  const scored = paragraphs.map((p) => ({
    text: p.trim(),
    score: scoreParagraph(p),
  }));

  // Sort by score descending, then keep document order for top ones
  // Strategy: take all high-score paragraphs first, then pad with more if space allows
  const highScore = scored
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);
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
const MAX_CHUNK_CHARS = 55000;

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

const EXTRACTION_PROMPT = `You are a strict text extraction tool. Your ONLY job is to find and copy specific policy text that is physically present in the document below.

════════════════════════════════════════════════════════
ABSOLUTE RULES — violating any of these is a critical error:
════════════════════════════════════════════════════════
1. COPY ONLY. You may ONLY copy text that appears word-for-word in the source document. Nothing else.
2. NEVER INVENT. Do not write, rephrase, summarise, or infer anything. If you did not read it verbatim in the source, do not output it.
3. NEVER ASSUME. A policy existing on the site is NOT evidence it exists in this document. If it is not explicitly stated here, return null.
4. NEVER EXAGGERATE. Do not expand, embellish, or add context not present in the exact source text.
5. WHEN IN DOUBT → null. If you are not 100% certain the text is present verbatim, return null.
6. null IS THE CORRECT ANSWER when a policy is not found. It is not a failure — it means the site genuinely does not state that policy in this content.
7. Return ONLY valid JSON. No markdown, no code fences, no explanation text.

════════════════════════════════════════════════════════
HOW TO EXTRACT:
════════════════════════════════════════════════════════
- Scan the source document below for each policy type.
- If you find relevant text: copy the EXACT sentences/paragraphs verbatim, including all amounts (£/$), percentages, timeframes, and conditions as written.
- If the text is long, copy the full relevant section — do NOT truncate or summarise it.
- If NOT found: return null for that field. Do not guess.

Policy search terms to look for (also look for synonyms listed):
- coolingOffPeriod → look for: "cooling off", "cooling-off", "14 days", "24 hours to cancel", "cancellation period after signing"
- noVisaNoPay → look for: "visa", "unable to obtain a visa", "visa refusal", "visa refused"
- noPlaceNoPay → look for: "grades", "university place", "offer withdrawn", "results day", "A-levels", "exam results"
- universityCourseModification → look for: "course cancelled", "course changed", "course withdrawn", "module cancelled"
- earlyTermination → look for: "early termination", "leave early", "end your tenancy early", "break clause", "exit early"
- delayedArrivals → look for: "delayed arrival", "travel restrictions", "late arrival", "arrive later"
- replacementTenant → look for: "replacement tenant", "tenancy takeover", "find someone", "subletting", "assign your tenancy"
- deferringStudies → look for: "deferring", "defer your studies", "gap year", "postpone"
- universityIntakeDelayed → look for: "intake delayed", "semester delayed", "university postponed", "start date delayed"
- noQuestionsAsked → look for: "no questions asked", "unconditional", "cancel for any reason", "free cancellation"
- extenuatingCircumstances → look for: "extenuating circumstances", "medical grounds", "bereavement", "compassionate grounds", "serious illness"
- bookingDeposit → look for: "booking fee", "booking deposit", "reservation fee", "advance payment", "holding deposit"
- securityDeposit → look for: "security deposit", "damage deposit", "bond", "damage waiver", "returnable deposit"
- paymentInstalmentPlan → look for: "instalment", "installment", "payment plan", "monthly payments", "quarterly", "termly payments"
- modeOfPayment → look for: "payment method", "bank transfer", "credit card", "debit card", "direct debit", "how to pay"
- guarantorRequirement → look for: "guarantor", "guarantor required", "UK guarantor", "guarantee your rent"
- additionalFees → look for: "admin fee", "late payment fee", "additional charges", "room change fee", "cleaning fee", "penalty"

════════════════════════════════════════════════════════
OUTPUT FORMAT:
════════════════════════════════════════════════════════
Return this exact JSON structure — values must be verbatim copied text OR null:
{
  "cancellationPolicies": {
    "coolingOffPeriod": null,
    "noVisaNoPay": null,
    "noPlaceNoPay": null,
    "universityCourseModification": null,
    "earlyTermination": null,
    "delayedArrivals": null,
    "replacementTenant": null,
    "deferringStudies": null,
    "universityIntakeDelayed": null,
    "noQuestionsAsked": null,
    "extenuatingCircumstances": null,
    "other": null
  },
  "paymentPolicies": {
    "bookingDeposit": null,
    "securityDeposit": null,
    "paymentInstalmentPlan": null,
    "modeOfPayment": null,
    "guarantorRequirement": null,
    "additionalFees": null
  }
}

════════════════════════════════════════════════════════
SOURCE DOCUMENT TO EXTRACT FROM:
════════════════════════════════════════════════════════
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
      if (
        !merged.cancellationPolicies[key] &&
        result.cancellationPolicies?.[key]
      ) {
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

// ─── Gemini extraction ─────
// ──────────────────────────────────────────────────

// Models in priority order — best first, confirmed stable
const MODEL_PRIORITY = [
  "gemini-2.5-flash", // Gemini 2.5 Flash — primary (fastest, best quality)
  "gemini-2.5-flash-lite", // Gemini 2.5 Flash Lite — lighter, higher quota limits
  "gemini-2.0-flash", // Gemini 2.0 Flash — reliable stable fallback
];

const GEMINI_CALL_TIMEOUT_MS = 45000; // 45 seconds per call — prevents slow models stalling

/**
 * Try content extraction across all (key × model) combinations.
 * Strategy: for each model, try every key before falling to the next model.
 * This maximises quota across both keys before degrading model quality.
 *
 * Attempt order (7 keys × 3 models = 21 combinations):
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
  log: ReqLog,
): Promise<ExtractedPolicies | null | "quota"> {
  let responseText = "";
  let lastErr: Error | null = null;
  let allQuota = true; // assume quota until we see a non-quota failure

  outer: for (const modelName of MODEL_PRIORITY) {
    for (let ki = 0; ki < clients.length; ki++) {
      try {
        log.info(
          { modelName, keyIndex: ki + 1, label, chars: content.length },
          "Calling Gemini",
        );
        const model = clients[ki].getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
          },
        });
        const result = await Promise.race([
          model.generateContent(EXTRACTION_PROMPT + content),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Gemini timeout after ${GEMINI_CALL_TIMEOUT_MS / 1000}s`,
                  ),
                ),
              GEMINI_CALL_TIMEOUT_MS,
            ),
          ),
        ]);
        responseText = result.response.text().trim();
        log.info(
          { modelName, keyIndex: ki + 1, label },
          "Gemini call succeeded",
        );
        break outer; // success — stop trying
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        const isQuota =
          lastErr.message.includes("429") ||
          lastErr.message.toLowerCase().includes("quota");
        if (!isQuota) allQuota = false;
        log.warn(
          {
            modelName,
            keyIndex: ki + 1,
            label,
            quota: isQuota,
            err: lastErr.message.slice(0, 200),
          },
          isQuota
            ? "Quota hit — trying next key/model"
            : "Model call failed — trying next",
        );
      }
    }
  }

  if (!responseText) {
    log.error(
      { label, err: lastErr?.message?.slice(0, 200) },
      "All key+model combinations failed",
    );
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
    log.warn(
      { label, snippet: responseText.slice(0, 300) },
      "Failed to parse Gemini JSON",
    );
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

  const rootUrl = `${parsedUrl.protocol}//${parsedUrl.host}/`;

  const pagesVisited: string[] = [];

  interface PageData {
    url: string;
    text: string;
    html: string;
  }
  const pages: PageData[] = [];

  // ── Helper: add page to collection if not already present ──────────────────
  function addPage(r: FetchResult): void {
    if (!pagesVisited.includes(r.finalUrl) && r.text.length > 100) {
      pagesVisited.push(r.finalUrl);
      pages.push({ url: r.finalUrl, text: r.text, html: r.html });
      log.info(
        { url: r.finalUrl, source: r.source, len: r.text.length },
        "Page added",
      );
    }
  }

  // ── Helper: get raw HTML for link discovery (Jina returns plain text) ───────
  async function getRawHtml(targetUrl: string): Promise<string | null> {
    try {
      const res = await fetch(targetUrl, {
        headers: buildBrowserHeaders(USER_AGENTS[5]),
        redirect: "follow",
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) return await res.text();
    } catch {
      /* ignore */
    }
    return null;
  }

  try {
    // ── Step 1a: Fetch the given URL ─────────────────────────────────────────
    try {
      const r = await fetchRobust(url, log);
      addPage(r);
    } catch (e) {
      log.warn({ url, err: String(e) }, "Given URL failed");
    }

    // ── Step 1b: Always also fetch the root domain.
    // The homepage contains the site-wide navigation (FAQs, T&Cs, policies)
    // even when the user submits a deep property/room URL.
    if (
      rootUrl !== url &&
      !pagesVisited.some((p) => p === rootUrl || p === rootUrl.slice(0, -1))
    ) {
      try {
        const r = await fetchRobust(rootUrl, log);
        addPage(r);
      } catch (e) {
        log.warn({ rootUrl, err: String(e) }, "Root domain fetch failed");
      }
    }

    // If we got nothing at all, bail out
    if (pages.length === 0) {
      res
        .status(500)
        .json({
          error:
            "Unable to access this website. Please check the URL and try again.",
        });
      return;
    }

    // ── Step 1c: Extract real links from all fetched pages ─────────────────────
    // We get raw HTML (not Jina text) because Jina strips <a> tags.
    // Links are collected from BOTH the given page AND the homepage —
    // the homepage nav reliably contains FAQs, T&Cs, and policy links.
    const htmlSources: Array<{ html: string; base: string }> = [];

    for (const page of pages) {
      const rawHtml = page.html.includes("<a ")
        ? page.html
        : await getRawHtml(page.url);
      if (rawHtml) htmlSources.push({ html: rawHtml, base: page.url });
    }

    // Discover real links found on the site (no guessing)
    const seen = new Set<string>(pagesVisited);
    const orderedFetchList: string[] = [];
    for (const { html, base } of htmlSources) {
      for (const link of findAllInternalLinks(html, base, 30)) {
        if (!seen.has(link)) {
          seen.add(link);
          orderedFetchList.push(link);
        }
      }
    }

    log.info(
      { discovered: orderedFetchList.length },
      "Real links discovered from site HTML",
    );

    // ── Step 1d: Fetch top 25 real links in parallel ──────────────────────────
    const toFetch = orderedFetchList.slice(0, 25);

    const subResults = await Promise.allSettled(
      toFetch.map(async (link) => {
        try {
          const r = await fetchRobust(link, log);
          return r;
        } catch (e) {
          log.warn({ link, err: String(e) }, "Sub-page fetch failed");
          return null;
        }
      }),
    );

    for (const r of subResults) {
      if (r.status === "fulfilled" && r.value) addPage(r.value);
    }

    log.info(
      { totalPages: pages.length, urls: pagesVisited },
      "All pages collected",
    );
  } catch (err) {
    log.error({ err, url }, "Page collection failed unexpectedly");
    res
      .status(500)
      .json({
        error: err instanceof Error ? err.message : "Failed to fetch pages",
      });
    return;
  }

  if (pages.length === 0) {
    res
      .status(500)
      .json({ error: "Could not retrieve any content from this site." });
    return;
  }

  // ── Phase 2: Build focused document from policy-relevant paragraphs ──────────
  // Each page is filtered to only include paragraphs containing policy keywords.
  // This dramatically reduces content size and keeps extraction within 1 Gemini call.

  // Score and rank pages so the most policy-rich pages get their full allocation
  // before the combined character budget runs out.
  const scoredPages = pages.map((page) => {
    const relevant = extractRelevantText(page.text, MAX_CHARS_PER_PAGE);
    const score = relevant
      .split(/\n{2,}/)
      .reduce((sum, p) => sum + scoreParagraph(p), 0);
    return { page, relevant, score };
  });

  // Primary pages user gave us always appear first even if lower score
  const primaryUrl = pages[0]?.url ?? "";
  scoredPages.sort((a, b) => {
    if (a.page.url === primaryUrl) return -1;
    if (b.page.url === primaryUrl) return 1;
    return b.score - a.score;
  });

  const pageSegments: string[] = [];
  for (const { page, relevant } of scoredPages) {
    // Only include pages with substantial policy content — filters out 404 pages
    // and pages where only nav/footer mentions a policy keyword
    if (relevant.trim().length >= MIN_PAGE_POLICY_CHARS) {
      pageSegments.push(`=== SOURCE: ${page.url} ===\n${relevant}`);
    } else {
      log.debug(
        { url: page.url, chars: relevant.trim().length },
        "Page excluded — insufficient policy content",
      );
    }
  }

  const combinedDocument = pageSegments
    .join("\n\n")
    .slice(0, MAX_COMBINED_CHARS);

  log.info(
    {
      totalChars: combinedDocument.length,
      pages: pages.length,
      segments: pageSegments.length,
    },
    "Policy-focused document built",
  );

  // ── Phase 3: Gemini extraction (single call, 2-chunk fallback if rare edge case) ──

  const clients = getGeminiClients();
  const allResults: ExtractedPolicies[] = [];
  let quotaHit = false;

  log.info(
    { keys: clients.length, models: MODEL_PRIORITY.length },
    "Starting Gemini extraction",
  );

  if (combinedDocument.length <= MAX_CHUNK_CHARS) {
    // Standard path: single call with all content
    const result = await callGemini(
      clients,
      combinedDocument,
      "full-document",
      log,
    );
    if (result === "quota") {
      quotaHit = true;
    } else if (result) allResults.push(result);
  } else {
    // Fallback: content too large — split into 2 sequential calls with delay
    const fallbackChunks = splitForFallback(combinedDocument).slice(0, 2);
    log.info(
      { chunks: fallbackChunks.length },
      "Document large — using 2-chunk sequential fallback",
    );
    for (let i = 0; i < fallbackChunks.length; i++) {
      const result = await callGemini(
        clients,
        fallbackChunks[i],
        `chunk-${i + 1}-of-${fallbackChunks.length}`,
        log,
      );
      if (result === "quota") {
        quotaHit = true;
        break;
      } else if (result) allResults.push(result);
      if (i < fallbackChunks.length - 1) await delay(7000);
    }
  }

  if (allResults.length === 0) {
    if (quotaHit) {
      res.status(429).json({
        error:
          "Your Google AI API key has reached its free tier daily request limit (20 requests/day for Gemini 2.5 Flash). The quota resets at midnight Pacific Time. Please try again tomorrow, or visit https://ai.google.dev to upgrade your API plan.",
      });
    } else {
      res
        .status(500)
        .json({
          error:
            "AI extraction failed — could not parse any policy data. Please try again.",
        });
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
    "Policy extraction complete",
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
