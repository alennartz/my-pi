import type { QuotaVerdict, QuotaPolicy } from "./types.js";

function formatDate(daysAhead: number): string {
  const ms = Date.now() + daysAhead * 86_400_000;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatReset(resetAt: number): string {
  return new Date(resetAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function decideBlock(args: {
  verdict: QuotaVerdict;
  policy: QuotaPolicy;
  bypassActive: boolean;
}): { blocked: false } | { blocked: true; kind: "soft" | "hard"; message: string } {
  const { verdict, policy, bypassActive } = args;

  if (verdict.state === "hard-exceeded" && policy.enforceHardCap) {
    const dateStr = verdict.daysAhead > 0 ? ` (spending at ${formatDate(verdict.daysAhead)}'s budget)` : "";
    const message =
      `quota hard cap exceeded${dateStr}; resets ${formatReset(verdict.resetAt)}`;
    return { blocked: true, kind: "hard", message };
  }

  if (verdict.state === "soft-exceeded" && !bypassActive) {
    const dateStr = verdict.daysAhead > 0 ? ` (spending at ${formatDate(verdict.daysAhead)}'s budget)` : "";
    const bypassHint = policy.bypassAllowed ? " — run /quota bypass on to continue" : "";
    const message =
      `quota soft cap exceeded${dateStr}; resets ${formatReset(verdict.resetAt)}${bypassHint}`;
    return { blocked: true, kind: "soft", message };
  }

  return { blocked: false };
}
