import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useExtractPolicies } from "@workspace/api-client-react";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Search,
  Loader2,
  AlertCircle,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Globe,
  FileText,
  CreditCard,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
} from "lucide-react";

const formSchema = z.object({
  url: z.string().url("Please enter a valid URL (e.g. https://example.com)"),
});

type FormValues = z.infer<typeof formSchema>;

const CANCELLATION_LABELS: Record<string, string> = {
  coolingOffPeriod: "Cooling Off Period",
  noVisaNoPay: "No Visa No Pay",
  noPlaceNoPay: "No Place No Pay",
  universityCourseModification: "University Course Cancellation/Modification",
  earlyTermination: "Early Termination by Students",
  delayedArrivals: "Delayed Arrivals & Travel Restrictions",
  replacementTenant: "Replacement Tenant Found",
  deferringStudies: "Deferring Studies",
  universityIntakeDelayed: "University Intake Delayed",
  noQuestionsAsked: "No Questions Asked",
  extenuatingCircumstances: "Extenuating Circumstances",
  other: "Other Cancellation Policies",
};

const PAYMENT_LABELS: Record<string, string> = {
  bookingDeposit: "Booking Deposit",
  securityDeposit: "Security Deposit",
  paymentInstalmentPlan: "Payment Instalment Plan",
  modeOfPayment: "Mode of Payment",
  guarantorRequirement: "Guarantor Requirement",
  additionalFees: "Additional Fees",
};

interface PolicyCardProps {
  label: string;
  value: string | null;
}

function PolicyCard({ label, value }: PolicyCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const hasValue = value !== null && value.trim() !== "";

  const handleCopy = () => {
    if (value) {
      navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      className={`rounded-lg border transition-all duration-200 ${
        hasValue
          ? "bg-card border-card-border shadow-sm"
          : "bg-muted/30 border-border opacity-70"
      }`}
      data-testid={`policy-card-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer select-none"
        onClick={() => hasValue && setExpanded((e) => !e)}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {hasValue ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
          ) : (
            <XCircle className="w-4 h-4 text-muted-foreground shrink-0" />
          )}
          <span
            className={`text-sm font-medium truncate ${
              hasValue ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            {label}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {!hasValue && (
            <span className="text-xs text-muted-foreground">Not found</span>
          )}
          {hasValue && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopy();
                }}
                className="p-1 rounded hover:bg-accent transition-colors"
                data-testid={`copy-${label.toLowerCase().replace(/\s+/g, "-")}`}
                title="Copy to clipboard"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
                )}
              </button>
              {expanded ? (
                <ChevronUp className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              )}
            </>
          )}
        </div>
      </div>
      {hasValue && expanded && (
        <div className="px-4 pb-4 pt-0">
          <div className="bg-muted/40 rounded-md px-3 py-2.5 border border-border/50">
            <p
              className="text-sm text-foreground leading-relaxed whitespace-pre-wrap"
              data-testid={`policy-content-${label.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {value}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

interface PolicySectionProps {
  title: string;
  icon: React.ReactNode;
  policies: Record<string, string | null>;
  labels: Record<string, string>;
  color: string;
}

function PolicySection({ title, icon, policies, labels, color }: PolicySectionProps) {
  const found = Object.values(policies).filter((v) => v !== null && v.trim() !== "").length;
  const total = Object.keys(labels).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`p-1.5 rounded-md ${color}`}>{icon}</div>
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
        </div>
        <Badge
          variant="secondary"
          className="text-xs font-medium"
          data-testid={`badge-${title.toLowerCase().replace(/\s+/g, "-")}`}
        >
          {found}/{total} found
        </Badge>
      </div>
      <div className="space-y-2">
        {Object.entries(labels).map(([key, label]) => (
          <PolicyCard key={key} label={label} value={policies[key] ?? null} />
        ))}
      </div>
    </div>
  );
}

export default function Extractor() {
  const [result, setResult] = useState<{
    url: string;
    pagesVisited: string[];
    cancellationPolicies: Record<string, string | null>;
    paymentPolicies: Record<string, string | null>;
    extractedAt: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { url: "" },
  });

  const extractMutation = useExtractPolicies({
    mutation: {
      onSuccess: (data) => {
        setResult(data as typeof result);
        setError(null);
      },
      onError: (err) => {
        const message =
          (err as { data?: { error?: string } })?.data?.error ??
          "An unexpected error occurred. Please try again.";
        setError(message);
        setResult(null);
      },
    },
  });

  const onSubmit = (values: FormValues) => {
    setError(null);
    setResult(null);
    extractMutation.mutate({ data: { url: values.url } });
  };

  const isPending = extractMutation.isPending;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
              <FileText className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-semibold text-foreground text-sm">PolicyExtract</span>
          </div>
          <div className="h-4 w-px bg-border" />
          <span className="text-xs text-muted-foreground">
            Student Housing Policy Extractor
          </span>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        {/* Hero */}
        <div className="text-center space-y-2">
          <h1
            className="text-2xl font-bold text-foreground"
            data-testid="page-title"
          >
            Extract Housing Policies
          </h1>
          <p className="text-sm text-muted-foreground max-w-xl mx-auto">
            Paste any student accommodation website URL below. Our AI will scan the
            site and extract all cancellation and payment policies for you.
          </p>
        </div>

        {/* URL Input Form */}
        <div className="bg-card border border-card-border rounded-xl shadow-sm p-5">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
              <FormField
                control={form.control}
                name="url"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                          <Input
                            {...field}
                            placeholder="https://example.com/student-accommodation"
                            className="pl-9 text-sm h-10"
                            data-testid="input-url"
                            disabled={isPending}
                          />
                        </div>
                        <Button
                          type="submit"
                          disabled={isPending}
                          className="h-10 px-5 shrink-0"
                          data-testid="button-extract"
                        >
                          {isPending ? (
                            <>
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              Extracting...
                            </>
                          ) : (
                            <>
                              <Search className="w-4 h-4 mr-2" />
                              Extract Policies
                            </>
                          )}
                        </Button>
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </form>
          </Form>

          {isPending && (
            <div
              className="mt-4 flex items-center gap-3 text-sm text-muted-foreground bg-muted/40 rounded-lg px-4 py-3"
              data-testid="loading-indicator"
            >
              <Loader2 className="w-4 h-4 animate-spin shrink-0 text-primary" />
              <span>
                Scanning the website and extracting policies with AI. This may take
                20-40 seconds depending on site complexity...
              </span>
            </div>
          )}
        </div>

        {/* Error State */}
        {error && (
          <div
            className="flex items-start gap-3 bg-destructive/10 border border-destructive/20 rounded-xl px-5 py-4"
            data-testid="error-message"
          >
            <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-destructive">Extraction Failed</p>
              <p className="text-sm text-destructive/80">{error}</p>
              {(error?.toLowerCase().includes("blocked") || error?.toLowerCase().includes("403") || error?.toLowerCase().includes("bot protection")) && (
                <div className="mt-2 text-xs text-muted-foreground bg-background/60 rounded-md px-3 py-2 border border-border/50">
                  <p className="font-medium text-foreground mb-1">Tips to get around this:</p>
                  <ul className="space-y-0.5 list-disc list-inside">
                    <li>Try the site's <strong>terms</strong> or <strong>policy page</strong> URL directly (e.g. <code className="text-xs bg-muted px-1 rounded">/cancellation-policy</code>)</li>
                    <li>Try the site's main homepage URL instead of a specific room page</li>
                    <li>Look for a <strong>/faq</strong> or <strong>/terms-and-conditions</strong> URL on the site</li>
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-6" data-testid="extraction-results">
            {/* Meta info */}
            <div className="flex flex-wrap items-center justify-between gap-3 bg-card border border-card-border rounded-xl px-5 py-4 shadow-sm">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  <span className="text-sm font-medium text-foreground">
                    Extraction Complete
                  </span>
                </div>
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
                  data-testid="link-source-url"
                >
                  <ExternalLink className="w-3 h-3" />
                  {result.url}
                </a>
              </div>
              <div className="flex flex-wrap gap-2">
                {result.pagesVisited.map((page, i) => (
                  <Badge
                    key={i}
                    variant="outline"
                    className="text-xs font-normal"
                    data-testid={`badge-page-${i}`}
                  >
                    {i === 0 ? "Main page" : `Policy page ${i}`}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Stats bar */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                {
                  label: "Pages Scanned",
                  value: result.pagesVisited.length,
                  testId: "stat-pages",
                },
                {
                  label: "Cancellation Found",
                  value: Object.values(result.cancellationPolicies).filter(
                    (v) => v !== null
                  ).length,
                  testId: "stat-cancellation",
                },
                {
                  label: "Payment Found",
                  value: Object.values(result.paymentPolicies).filter(
                    (v) => v !== null
                  ).length,
                  testId: "stat-payment",
                },
                {
                  label: "Total Policies",
                  value:
                    Object.values(result.cancellationPolicies).filter(
                      (v) => v !== null
                    ).length +
                    Object.values(result.paymentPolicies).filter((v) => v !== null)
                      .length,
                  testId: "stat-total",
                },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="bg-card border border-card-border rounded-lg px-4 py-3 text-center shadow-sm"
                  data-testid={stat.testId}
                >
                  <div className="text-2xl font-bold text-primary">{stat.value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{stat.label}</div>
                </div>
              ))}
            </div>

            {/* Policies grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <PolicySection
                title="Cancellation Policies"
                icon={<FileText className="w-3.5 h-3.5 text-amber-600" />}
                policies={result.cancellationPolicies}
                labels={CANCELLATION_LABELS}
                color="bg-amber-50 dark:bg-amber-950/30"
              />
              <PolicySection
                title="Payment Policies"
                icon={<CreditCard className="w-3.5 h-3.5 text-blue-600" />}
                policies={result.paymentPolicies}
                labels={PAYMENT_LABELS}
                color="bg-blue-50 dark:bg-blue-950/30"
              />
            </div>

            {/* Pages visited detail */}
            {result.pagesVisited.length > 1 && (
              <div className="bg-card border border-card-border rounded-xl px-5 py-4 shadow-sm">
                <h3 className="text-sm font-medium text-foreground mb-3">
                  Pages Scanned
                </h3>
                <div className="space-y-1.5">
                  {result.pagesVisited.map((page, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center shrink-0">
                        <span className="text-xs text-muted-foreground font-medium">
                          {i + 1}
                        </span>
                      </div>
                      <a
                        href={page}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted-foreground hover:text-primary transition-colors truncate flex items-center gap-1"
                        data-testid={`link-visited-page-${i}`}
                      >
                        <ExternalLink className="w-3 h-3 shrink-0" />
                        {page}
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Empty state */}
        {!result && !isPending && !error && (
          <div className="text-center py-12 space-y-3" data-testid="empty-state">
            <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto">
              <Search className="w-7 h-7 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">
                Enter a housing website URL above
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Works with student accommodation, PBSA, and university-affiliated housing sites
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2 pt-1">
              {[
                "Cooling Off Period",
                "No Visa No Pay",
                "No Place No Pay",
                "Booking Deposit",
                "Guarantor",
                "Instalment Plans",
              ].map((tag) => (
                <span
                  key={tag}
                  className="text-xs bg-muted/60 text-muted-foreground px-2.5 py-1 rounded-full border border-border"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
