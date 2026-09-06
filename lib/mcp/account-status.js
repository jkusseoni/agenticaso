/**
 * Compact get_account_status payload from existing billing views.
 */
import { isUnlimited } from "../billing/plans.js";

export function getMcpPublicSiteUrl(env = process.env) {
  const raw = String(env.MCP_PUBLIC_URL || env.NEXT_PUBLIC_SITE_URL || "https://agenticaso.com").trim();
  return raw.replace(/\/$/, "") || "https://agenticaso.com";
}

export function remainingOf(limit, used) {
  if (isUnlimited(limit)) return null;
  return Math.max(0, Number(limit || 0) - Number(used || 0));
}

/**
 * @param {{ billingView: object, siteUrl?: string }} opts
 */
export function buildAccountStatus({ billingView, siteUrl = getMcpPublicSiteUrl() }) {
  const view = billingView;
  const usage = view?.usage || {};
  const ai = usage.aiTests || { used: 0, limit: 0 };
  const sites = usage.websites || { used: 0, limit: 0 };
  const monitoring = usage.monitoring || { used: 0, limit: 0 };
  const origin = String(siteUrl || "").replace(/\/$/, "");

  return {
    plan: view.plan,
    planName: view.planName,
    isPaid: view.isPaid === true,
    status: view.status,
    dashboardUrl: `${origin}/dashboard`,
    upgradeUrl: `${origin}/billing?utm_source=mcp&utm_medium=mcp_tool&utm_campaign=get_account_status`,
    remaining: {
      aiTests: remainingOf(ai.limit, ai.used),
      websites: remainingOf(sites.limit, sites.used),
      monitoring: remainingOf(monitoring.limit, monitoring.used),
    },
    usage: {
      aiTests: { used: ai.used, limit: ai.limit },
      websites: { used: sites.used, limit: sites.limit },
      monitoring: { used: monitoring.used, limit: monitoring.limit },
      buyerQuestionsLimit: usage.buyerQuestions?.limit ?? null,
      periodEnd: usage.periodEnd || null,
    },
    features: view.features || {},
  };
}
