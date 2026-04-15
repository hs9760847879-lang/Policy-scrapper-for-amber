import { Router, type IRouter } from "express";
import * as cheerio from "cheerio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ExtractPoliciesBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function getGeminiClient(): GoogleGenerativeAI {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY environment variable is not set");
  }
  return new GoogleGenerativeAI(apiKey);
}

// Rotate through realistic UA strings to avoid fingerprinting
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
  // Googlebot - many sites whitelist this
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];

function buildHeaders(ua: string, referer?: string): Record<string, string> {
  const isGooglebot = ua.includes("Googlebot");
  const base: Record<string, string> = {
    "User-Agent": ua,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9,en-US;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Upgrade-Insecure-Requests": "1",
  };

  if (!isGooglebot) {
    base["Sec-Fetch-Dest"] = "document";
    base["Sec-Fetch-Mode"] = "navigate";
    base["Sec-Fetch-Site"] = referer ? "same-origin" : "none";
    base["Sec-Fetch-User"] = "?1";
    base["Sec-Ch-Ua"] = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';
    base["Sec-Ch-Ua-Mobile"] = "?0";
    base["Sec-Ch-Ua-Platform"] = '"Windows"';
  }

  if (referer) {
    base["Referer"] = referer;
  }

  return base;
}

async function fetchWithRetry(
  url: string,
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void }
): Promise<{ html: string; finalUrl: string }> {
  const errors: string[] = [];

  for (let i = 0; i < USER_AGENTS.length; i++) {
    const ua = USER_AGENTS[i];
    try {
      log.info({ url, ua: ua.slice(0, 40) }, `Fetch attempt ${i + 1}`);

      const response = await fetch(url, {
        headers: buildHeaders(ua),
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });

      if (response.ok) {
        const html = await response.text();
        const finalUrl = response.url || url;
        log.info({ url, status: response.status, finalUrl }, "Fetch succeeded");
        return { html, finalUrl };
      }

      errors.push(`UA[${i}] HTTP ${response.status}`);
      log.warn({ url, status: response.status, ua: ua.slice(0, 40) }, `Fetch attempt ${i + 1} failed`);

      // For 403/429, try next UA; for 404/5xx, no point retrying
      if (response.status === 404 || response.status >= 500) {
        throw new Error(`HTTP ${response.status} - ${response.statusText}`);
      }

      // Small delay between retries
      if (i < USER_AGENTS.length - 1) {
        await new Promise((r) => setTimeout(r, 500 + i * 300));
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("HTTP")) throw err;
      errors.push(`UA[${i}] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    `All fetch attempts blocked (tried ${USER_AGENTS.length} strategies). The site may require JavaScript rendering or has strict bot protection.`
  );
}

function extractTextFromHtml(html: string): string {
  const $ = cheerio.load(html);
  // Remove noise elements
  $("script, style, nav, noscript, iframe, svg, img, [role='navigation'], [role='banner']").remove();
  // Prefer main content areas
  const mainSelectors = ["main", "article", "#content", "#main", ".content", ".main", ".page-content", "body"];
  for (const sel of mainSelectors) {
    const el = $(sel);
    if (el.length && el.text().trim().length > 100) {
      return el.text().replace(/\s+/g, " ").trim();
    }
  }
  return $("body").text().replace(/\s+/g, " ").trim();
}

function findPolicyLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const policyKeywords = [
    "cancellation", "cancel", "policy", "policies", "terms", "conditions",
    "booking", "payment", "refund", "deposit", "faq", "faqs", "help",
    "deferral", "visa", "guarantor",
  ];

  const links = new Set<string>();

  $("a[href]").each((_: number, el: cheerio.Element) => {
    const href = $(el).attr("href");
    if (!href) return;

    try {
      const fullUrl = new URL(href, baseUrl);
      // Only same-origin links
      if (fullUrl.origin !== base.origin) return;
      // Skip non-HTML resources
      if (fullUrl.pathname.match(/\.(jpg|jpeg|png|gif|pdf|doc|docx|zip|css|js|ico|svg|xml|json|mp4|webp)$/i)) return;
      // Skip current page & anchor-only
      if (fullUrl.pathname === base.pathname) return;

      const text = ($(el).text() || "").toLowerCase();
      const urlLower = fullUrl.pathname.toLowerCase();

      const isRelevant = policyKeywords.some(
        (kw) => text.includes(kw) || urlLower.includes(kw)
      );

      if (isRelevant) {
        // Clean up hash fragments for deduplication
        fullUrl.hash = "";
        links.add(fullUrl.href);
      }
    } catch {
      // skip invalid URLs
    }
  });

  return Array.from(links).slice(0, 6);
}

// Try the root domain when a deep page is blocked, to find policy links from homepage
async function tryRootDomainFallback(
  originalUrl: string,
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void }
): Promise<{ html: string; url: string } | null> {
  try {
    const parsed = new URL(originalUrl);
    const rootUrl = `${parsed.protocol}//${parsed.host}/`;
    if (rootUrl === originalUrl) return null;
    log.info({ rootUrl }, "Trying root domain as fallback");
    const { html, finalUrl } = await fetchWithRetry(rootUrl, log);
    return { html, url: finalUrl };
  } catch {
    return null;
  }
}

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

Policy definitions to guide extraction:
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

  req.log.info({ url }, "Starting policy extraction");

  const pagesVisited: string[] = [];
  let allText = "";

  try {
    // ── Step 1: Try to fetch the given URL ──────────────────────────────────
    let mainHtml: string | null = null;
    let effectiveBaseUrl = url;

    try {
      const result = await fetchWithRetry(url, req.log);
      mainHtml = result.html;
      effectiveBaseUrl = result.finalUrl;
      pagesVisited.push(effectiveBaseUrl);
      const mainText = extractTextFromHtml(mainHtml);
      allText += `\n\n=== PAGE: ${effectiveBaseUrl} ===\n${mainText}`;
    } catch (fetchErr) {
      req.log.warn({ url, err: fetchErr }, "Main URL fetch failed, trying root domain");
    }

    // ── Step 2: If blocked, try root domain ─────────────────────────────────
    let htmlForLinkDiscovery = mainHtml;
    let linkDiscoveryBase = effectiveBaseUrl;

    if (!mainHtml) {
      const rootResult = await tryRootDomainFallback(url, req.log);
      if (rootResult) {
        htmlForLinkDiscovery = rootResult.html;
        linkDiscoveryBase = rootResult.url;
        pagesVisited.push(rootResult.url);
        const rootText = extractTextFromHtml(rootResult.html);
        allText += `\n\n=== PAGE: ${rootResult.url} ===\n${rootText}`;
      } else {
        // Both the page and root domain are unreachable
        const errMsg =
          "This website blocked all access attempts. " +
          "Try using the direct URL to the site's policy or terms page instead (e.g. https://example.com/cancellation-policy).";
        res.status(500).json({ error: errMsg });
        return;
      }
    }

    // ── Step 3: Discover and fetch policy sub-pages ──────────────────────────
    if (htmlForLinkDiscovery) {
      const policyLinks = findPolicyLinks(htmlForLinkDiscovery, linkDiscoveryBase);
      req.log.info({ policyLinks }, "Found policy-related links");

      for (const link of policyLinks) {
        if (pagesVisited.includes(link)) continue;
        try {
          const { html: subHtml, finalUrl: subFinal } = await fetchWithRetry(link, req.log);
          const subText = extractTextFromHtml(subHtml);
          allText += `\n\n=== PAGE: ${subFinal} ===\n${subText}`;
          pagesVisited.push(subFinal);
        } catch (err) {
          req.log.warn({ link, err }, "Failed to fetch policy sub-page");
        }
      }
    }

    if (!allText.trim()) {
      res.status(500).json({
        error: "Could not extract any content from this site. Try linking directly to a policy page.",
      });
      return;
    }

    // ── Step 4: Use Gemini to extract policies ───────────────────────────────
    const trimmedText = allText.slice(0, 60000);

    const genAI = getGeminiClient();
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const result = await model.generateContent(EXTRACTION_PROMPT + trimmedText);
    const responseText = result.response.text().trim();

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
    } catch (parseErr) {
      req.log.error({ parseErr, responseText }, "Failed to parse Gemini response as JSON");
      res.status(500).json({ error: "AI returned an unexpected response format. Please try again." });
      return;
    }

    res.json({
      url,
      pagesVisited,
      cancellationPolicies: policies.cancellationPolicies || {},
      paymentPolicies: policies.paymentPolicies || {},
      extractedAt: new Date().toISOString(),
      rawText: null,
    });

    req.log.info({ url, pagesVisited: pagesVisited.length }, "Policy extraction complete");
  } catch (err: unknown) {
    req.log.error({ err, url }, "Policy extraction failed");
    const message = err instanceof Error ? err.message : "Extraction failed";
    res.status(500).json({ error: message });
  }
});

export default router;
