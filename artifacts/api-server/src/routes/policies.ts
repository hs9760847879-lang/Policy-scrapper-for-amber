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

async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return await response.text();
}

function extractTextFromHtml(html: string): string {
  const $ = cheerio.load(html);
  // Remove noise elements
  $("script, style, nav, header, footer, noscript, iframe, svg, img").remove();
  // Get meaningful text
  const text = $("body").text();
  // Clean up whitespace
  return text.replace(/\s+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function findPolicyLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const policyKeywords = [
    "cancellation", "policy", "policies", "terms", "booking", "payment",
    "refund", "deposit", "conditions", "faq", "faqs", "help", "support",
  ];

  const links = new Set<string>();

  $("a[href]").each((_: number, el: cheerio.Element) => {
    const href = $(el).attr("href");
    if (!href) return;

    try {
      const fullUrl = new URL(href, baseUrl);
      // Only same-origin links
      if (fullUrl.origin !== base.origin) return;
      // Skip non-HTML pages
      if (fullUrl.pathname.match(/\.(jpg|jpeg|png|gif|pdf|doc|docx|zip|css|js|ico|svg|xml|json)$/i)) return;
      // Skip fragment-only or current page
      if (fullUrl.href === baseUrl || fullUrl.pathname === base.pathname) return;

      const text = ($(el).text() || "").toLowerCase();
      const urlLower = fullUrl.href.toLowerCase();

      const isRelevant = policyKeywords.some(
        (kw) => text.includes(kw) || urlLower.includes(kw)
      );

      if (isRelevant) {
        links.add(fullUrl.href);
      }
    } catch {
      // Invalid URL, skip
    }
  });

  return Array.from(links).slice(0, 5);
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

  // Validate URL
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

  const pagesVisited: string[] = [url];
  let allText = "";

  try {
    // Fetch the main page
    const mainHtml = await fetchPage(url);
    const mainText = extractTextFromHtml(mainHtml);
    allText += `\n\n=== PAGE: ${url} ===\n${mainText}`;

    // Find and fetch policy sub-pages (same domain only)
    const policyLinks = findPolicyLinks(mainHtml, url);
    req.log.info({ policyLinks }, "Found policy-related links");

    for (const link of policyLinks) {
      if (pagesVisited.includes(link)) continue;
      try {
        const subHtml = await fetchPage(link);
        const subText = extractTextFromHtml(subHtml);
        allText += `\n\n=== PAGE: ${link} ===\n${subText}`;
        pagesVisited.push(link);
      } catch (err) {
        req.log.warn({ link, err }, "Failed to fetch policy sub-page");
      }
    }

    // Trim text to avoid token limits (keep ~50k chars)
    const trimmedText = allText.slice(0, 50000);

    // Use Gemini to extract policies
    const genAI = getGeminiClient();
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const result = await model.generateContent(EXTRACTION_PROMPT + trimmedText);
    const responseText = result.response.text().trim();

    // Parse the JSON response
    let policies: {
      cancellationPolicies: Record<string, string | null>;
      paymentPolicies: Record<string, string | null>;
    };
    try {
      // Remove any markdown code blocks if present
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
