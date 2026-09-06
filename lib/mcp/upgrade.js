/**
 * MCP conversion fields. Does not change REST upgradePayload() JSON.
 */
import { remainingOf, getMcpPublicSiteUrl } from "./account-status.js";

export function buildMcpUpgradeUrl(siteUrl, campaign = "upgrade") {
  const origin = String(siteUrl || getMcpPublicSiteUrl()).replace(/\/$/, "");
  const utm = new URLSearchParams({
    utm_source: "mcp",
    utm_medium: "mcp_tool",
    utm_campaign: String(campaign || "upgrade"),
  });
  return `${origin}/billing?${utm.toString()}`;
}

export function remainingFromBillingView(billingView) {
  const usage = billingView?.usage || {};
  const ai = usage.aiTests || { used: 0, limit: 0 };
  const sites = usage.websites || { used: 0, limit: 0 };
  const monitoring = usage.monitoring || { used: 0, limit: 0 };
  return {
    aiTests: remainingOf(ai.limit, ai.used),
    websites: remainingOf(sites.limit, sites.used),
    monitoring: remainingOf(monitoring.limit, monitoring.used),
  };
}

/**
 * Attach MCP upgradeUrl / plan / remaining to an existing upgradePayload().
 * @param {object} upgrade
 * @param {{ siteUrl?: string, campaign?: string, billingView?: object, planId?: string }} [opts]
 */
export function withMcpConversion(upgrade, opts = {}) {
  const plan = opts.planId || upgrade?.plan || opts.billingView?.plan || null;
  return {
    ...(upgrade && typeof upgrade === "object" ? upgrade : {}),
    plan,
    remaining: remainingFromBillingView(opts.billingView),
    upgradeUrl: buildMcpUpgradeUrl(opts.siteUrl, opts.campaign),
  };
}
