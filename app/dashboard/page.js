"use client";

import React, { useCallback, useEffect, useState } from "react";
import { SignInButton, UserButton, useAuth, useUser } from "@clerk/nextjs";
import { buildDashboardView } from "@/lib/dashboard";
import { C, DISPLAY, BODY, formatDate } from "@/lib/dashboard/theme";
import {
  ScoreCard,
  MetricCard,
  ProviderCard,
  CompetitorTable,
  PerceptionPanel,
  TrendChart,
  AuditHistory,
  ActionList,
  WhatChanged,
  OpportunitiesPanel,
  BeforeAfterPanel,
  MonitoringStatusCard,
  AlertCenter,
  BillingUsageCard,
} from "@/components/agentic";
import { SiteFooter } from "@/components/site-footer";

export default function DashboardPage() {
  const { isSignedIn, isLoaded: authLoaded } = useAuth();
  const { isLoaded: userLoaded } = useUser();
  const [billing, setBilling] = useState(null);
  const isPaid = billing?.isPaid === true;

  const [phase, setPhase] = useState("loading"); // loading | ready | error | scanning
  const [error, setError] = useState("");
  const [auditList, setAuditList] = useState([]);
  const [audit, setAudit] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [dbStatus, setDbStatus] = useState("unknown");
  const [scanMsg, setScanMsg] = useState("");
  const [diagnosis, setDiagnosis] = useState(null);
  const [diagnosisLoading, setDiagnosisLoading] = useState(false);
  const [diagnosisError, setDiagnosisError] = useState("");
  const [activeFix, setActiveFix] = useState(null);
  const [fixLoadingId, setFixLoadingId] = useState(null);
  const [packFixes, setPackFixes] = useState([]);
  const [packLoading, setPackLoading] = useState(false);
  const [monitoring, setMonitoring] = useState(null);
  const [monitoringLoading, setMonitoringLoading] = useState(false);
  const [monitoringBusy, setMonitoringBusy] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [upgradeHint, setUpgradeHint] = useState("");

  const loadList = useCallback(async () => {
    const res = await fetch("/api/audits?limit=20");
    const data = await res.json().catch(() => ({}));
    if (res.status === 503) {
      setDbStatus("unavailable");
      setAuditList([]);
      return { audits: [], dbStatus: "unavailable" };
    }
    if (!res.ok) throw new Error(data.error || "Failed to load audits");
    setDbStatus("ok");
    setAuditList(data.audits || []);
    return { audits: data.audits || [], dbStatus: "ok" };
  }, []);

  const loadAudit = useCallback(async (id, list) => {
    const res = await fetch(`/api/audits/${id}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to load audit");
    setAudit(data.audit);
    setActiveFix(null);
    setPackFixes([]);
    setDiagnosis(null);
    setDiagnosisError("");

    const sameSite = (list || []).filter((a) => a.websiteId === data.audit.websiteId && a.id !== id && a.status === "completed");
    const prev = sameSite[0];
    if (prev) {
      try {
        const cmpRes = await fetch(`/api/audits/${id}/compare/${prev.id}`);
        const cmpData = await cmpRes.json().catch(() => ({}));
        if (cmpRes.ok) setComparison(cmpData.comparison || null);
        else setComparison(null);
      } catch {
        setComparison(null);
      }
    } else {
      setComparison(null);
    }

    setDiagnosisLoading(true);
    try {
      const dRes = await fetch(`/api/audits/${id}/diagnosis`);
      const dData = await dRes.json().catch(() => ({}));
      if (dRes.ok) setDiagnosis(dData);
      else setDiagnosisError(dData.error || "Diagnosis unavailable");
    } catch {
      setDiagnosisError("Diagnosis unavailable");
    } finally {
      setDiagnosisLoading(false);
    }

    try {
      const fRes = await fetch(`/api/audits/${id}/fixes`);
      if (fRes.ok) {
        const fData = await fRes.json().catch(() => ({}));
        setPackFixes(fData.fixes || []);
      } else {
        setPackFixes([]);
      }
    } catch {
      setPackFixes([]);
    }

    // Load monitoring + alerts for this website (stored data only)
    setMonitoringLoading(true);
    try {
      const websiteId = data.audit.websiteId;
      const [mRes, aRes] = await Promise.all([
        fetch("/api/monitoring"),
        fetch(`/api/alerts?websiteId=${encodeURIComponent(websiteId)}&limit=20`),
      ]);
      const mData = await mRes.json().catch(() => ({}));
      const aData = await aRes.json().catch(() => ({}));
      if (mRes.ok) {
        const match = (mData.monitorings || []).find((m) => m.websiteId === websiteId) || null;
        setMonitoring(match);
      } else setMonitoring(null);
      if (aRes.ok) setAlerts(aData.alerts || []);
      else setAlerts([]);
    } catch {
      setMonitoring(null);
      setAlerts([]);
    } finally {
      setMonitoringLoading(false);
    }
  }, []);
  const generateFix = async (issue) => {
    if (!audit?.id || !issue?.id) return;
    setFixLoadingId(issue.id);
    setActiveFix(null);
    try {
      const res = await fetch(`/api/audits/${audit.id}/fixes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: issue.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.upgrade || data.code === "ENTITLEMENT_REQUIRED") {
          setUpgradeHint(data.message || "Upgrade to Pro to generate actionable fixes.");
        }
        throw new Error(data.error || data.message || "Fix generation failed");
      }
      setActiveFix({ issueId: issue.id, fix: data.fix });
    } catch (e) {
      setError(e.message || "Fix generation failed");
    } finally {
      setFixLoadingId(null);
    }
  };

  const generateActionPack = async () => {
    if (!audit?.id) return;
    setPackLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/audits/${audit.id}/fixes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.upgrade || data.code === "ENTITLEMENT_REQUIRED") {
          setUpgradeHint(data.message || "Upgrade to Pro to generate actionable fixes.");
        }
        throw new Error(data.error || data.message || "Action pack generation failed");
      }
      setPackFixes(data.fixes || []);
    } catch (e) {
      setError(e.message || "Action pack generation failed");
    } finally {
      setPackLoading(false);
    }
  };

  const patchMonitoring = async (body) => {
    if (!monitoring?.id) return;
    setMonitoringBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/monitoring/${monitoring.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.upgrade || data.code === "ENTITLEMENT_REQUIRED") {
          setUpgradeHint(data.message || "Upgrade to unlock more capacity.");
          throw new Error(data.message || data.error || "Limit reached");
        }
        throw new Error(data.error || "Monitoring update failed");
      }
      setMonitoring(data.monitoring);
      if (body.action === "run_now") {
        setScanMsg(data.run?.ok ? "Run Now completed — new audit snapshot saved." : data.run?.reason || "Run finished.");
        if (data.run?.auditId) await refresh(data.run.auditId);
      }
    } catch (e) {
      setError(e.message || "Monitoring update failed");
    } finally {
      setMonitoringBusy(false);
    }
  };

  const enableMonitoring = async () => {
    if (!audit?.websiteId) return;
    if (!isPaid) {
      setError("Monitoring is a Pro feature.");
      return;
    }
    setMonitoringBusy(true);
    setError("");
    try {
      const res = await fetch("/api/monitoring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ websiteId: audit.websiteId, frequency: "weekly" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.upgrade || data.code === "ENTITLEMENT_REQUIRED") {
          setUpgradeHint(data.message || "Monitoring requires Pro.");
          throw new Error(data.message || data.error || "Could not enable monitoring");
        }
        throw new Error(data.error || "Could not enable monitoring");
      }
      setMonitoring(data.monitoring);
    } catch (e) {
      setError(e.message || "Could not enable monitoring");
    } finally {
      setMonitoringBusy(false);
    }
  };

  const markAlertsRead = async () => {
    try {
      await fetch("/api/alerts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true, websiteId: audit?.websiteId }),
      });
      setAlerts((prev) => prev.map((a) => ({ ...a, read: true })));
    } catch {
      /* ignore */
    }
  };
  const refresh = useCallback(async (preferredId) => {
    setError("");
    setPhase("loading");
    try {
      if (!isSignedIn) {
        setPhase("ready");
        return;
      }
      try {
        const bRes = await fetch("/api/billing/status");
        const bData = await bRes.json().catch(() => ({}));
        if (bRes.ok) setBilling(bData.billing || null);
      } catch {
        /* billing optional for dashboard */
      }
      const { audits, dbStatus: db } = await loadList();
      if (db === "unavailable") {
        setAudit(null);
        setPhase("ready");
        return;
      }
      const id = preferredId || audits[0]?.id;
      if (id) await loadAudit(id, audits);
      else setAudit(null);
      setPhase("ready");
    } catch (e) {
      setError(e.message || "Something went wrong");
      setPhase("error");
    }
  }, [isSignedIn, loadList, loadAudit]);

  useEffect(() => {
    if (!authLoaded || !userLoaded) return;
    refresh();
  }, [authLoaded, userLoaded, isSignedIn, refresh]);

  const view = buildDashboardView({
    audit,
    auditList,
    comparison,
    isPaid,
    dbStatus: dbStatus === "unavailable" ? "unavailable" : "ok",
  });

  const rescan = async () => {
    const url = audit?.website?.url || audit?.website?.domain;
    if (!url) {
      setError("No website on this audit to re-audit. Run a check from the home page first.");
      return;
    }
    if (!isPaid) {
      setError("Re-audit is a Pro feature.");
      return;
    }
    setPhase("scanning");
    setScanMsg("Re-auditing with multi-AI providers… this can take up to a minute.");
    setError("");
    try {
      const res = await fetch("/api/visibility/v2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || "Re-audit failed");
      const newId = data.persistence?.auditId || data.audit?.id;
      await refresh(newId);
      setScanMsg(
        data.persistence?.saved
          ? "Re-audit saved. Before/after shows observed change after re-audit."
          : "Re-audit finished (persistence skipped or failed)."
      );
    } catch (e) {
      setError(e.message || "Rescan failed");
      setPhase("ready");
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: C.paper, color: C.ink, fontFamily: BODY }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Inter:wght@400;500;600;700;800&display=swap');
        .dash-grid { display:grid; gap:14px; }
        .dash-kpis { display:grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap:14px; }
        .dash-providers { display:grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap:14px; }
        .dash-two { display:grid; grid-template-columns: 1.2fr .8fr; gap:14px; }
        @media (max-width: 900px) {
          .dash-kpis, .dash-providers, .dash-two { grid-template-columns: 1fr; }
        }
      `}</style>

      <header style={{ borderBottom: `1px solid ${C.border}`, background: "rgba(245,246,251,.9)", backdropFilter: "blur(8px)", position: "sticky", top: 0, zIndex: 40 }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 20px", height: 64, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <a href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: C.ink }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: `linear-gradient(135deg,${C.violet},${C.violetDeep})`, display: "grid", placeItems: "center", color: "#fff", fontWeight: 800, fontFamily: DISPLAY }}>a</div>
            <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 18 }}>Agenticaso</span>
          </a>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <a href="/billing" style={{ fontSize: 14, color: C.muted }}>Billing</a>
            <a href="/pricing" style={{ fontSize: 14, color: C.muted }}>Pricing</a>
            {isSignedIn ? <UserButton /> : (
              <SignInButton mode="modal">
                <button type="button" style={{ border: "none", background: "none", cursor: "pointer", fontWeight: 600, color: C.ink }}>Sign in</button>
              </SignInButton>
            )}
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 20px 64px" }}>
        {!authLoaded || !userLoaded || phase === "loading" ? (
          <StateBox title="Loading intelligence…" sub="Fetching your saved audits." />
        ) : !isSignedIn ? (
          <StateBox
            title="Sign in to open your dashboard"
            sub="Your AI visibility history is tied to your Agenticaso account."
            action={(
              <SignInButton mode="modal">
                <button type="button" style={primaryBtn()}>Sign in →</button>
              </SignInButton>
            )}
          />
        ) : phase === "error" ? (
          <StateBox title="Couldn’t load dashboard" sub={error} action={<button type="button" onClick={() => refresh()} style={primaryBtn()}>Retry</button>} />
        ) : phase === "scanning" ? (
          <StateBox title="Running multi-AI audit…" sub={scanMsg || "Querying ChatGPT, Perplexity, and Gemini."} />
        ) : view.state === "db_unavailable" ? (
          <StateBox title="Database unavailable" sub={view.message} action={<a href="/" style={primaryBtn()}>Back to home</a>} />
        ) : view.state === "empty" ? (
          <StateBox
            title="No audits yet"
            sub={view.message}
            action={<a href="/" style={primaryBtn()}>Run your first agent check →</a>}
          />
        ) : (
          <div className="dash-grid">
            <BillingUsageCard
              billing={billing}
              upgradeHint={
                upgradeHint ||
                (billing && !billing.isPaid
                  ? `Buyer questions capped at ${billing.usage?.buyerQuestions?.limit ?? 5}. Unlock 50 questions + weekly monitoring with Pro.`
                  : "")
              }
            />

            {/* A. Header */}
            <section style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 14, alignItems: "flex-start" }}>
              <div>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <PlanBadge plan={billing?.planName?.toUpperCase() || view.header.planBadge} />
                  <span style={{ fontSize: 12.5, color: C.muted }}>Last audit {formatDate(view.header.lastAuditAt)}</span>
                </div>
                <h1 style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 30, letterSpacing: -0.6, marginBottom: 4 }}>
                  {view.header.brand}
                </h1>
                <div style={{ fontSize: 14.5, color: C.muted }}>{view.header.domain}</div>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" onClick={rescan} style={primaryBtn()}>Re-audit</button>
                <button
                  type="button"
                  disabled={!view.gates?.export && !billing?.features?.exports}
                  title={view.gates?.export || billing?.features?.exports ? "Export audit JSON" : "Pro feature"}
                  style={{ ...ghostBtn(), opacity: view.gates?.export || billing?.features?.exports ? 1 : 0.55 }}
                  onClick={async () => {
                    if (!audit?.id) return;
                    try {
                      const res = await fetch(`/api/audits/${audit.id}/export`);
                      const data = await res.json().catch(() => ({}));
                      if (!res.ok) {
                        if (data.upgrade) setUpgradeHint(data.message || "Exports require Pro.");
                        throw new Error(data.message || data.error || "Export failed");
                      }
                      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `agenticaso-audit-${audit.id}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    } catch (e) {
                      setError(e.message || "Export failed");
                    }
                  }}
                >
                  Export
                </button>
              </div>
            </section>

            {error && <div style={{ color: C.coral, fontSize: 13.5 }}>{error}</div>}
            {scanMsg && phase === "ready" && <div style={{ color: C.teal, fontSize: 13.5 }}>{scanMsg}</div>}
            {view.partialProviderFailures && (
              <div style={{ background: "#FFF4DF", border: `1px solid #F5D79A`, borderRadius: 12, padding: "10px 14px", fontSize: 13.5, color: C.ink }}>
                Some AI providers failed on this audit. Scores use successful providers only.
              </div>
            )}

            {/* B + C */}
            <div className="dash-two">
              <ScoreCard score={view.hero.score} status={view.hero.status} delta={view.hero.delta} />
              <div className="dash-kpis">
                <MetricCard label="AI Share of Voice" value={view.kpis.mentionShare.value} delta={view.kpis.mentionShare.delta} />
                <MetricCard label="Recommendation Share" value={view.kpis.recommendationShare.value} delta={view.kpis.recommendationShare.delta} />
                <MetricCard label="Top-3 Share" value={view.kpis.top3Share.value} delta={view.kpis.top3Share.delta} />
              </div>
            </div>

            {/* D */}
            <section>
              <SectionTitle>Provider visibility</SectionTitle>
              <div className="dash-providers">
                {(view.providers || []).map((p) => (
                  <ProviderCard key={p.id} provider={p} locked={p.locked} />
                ))}
              </div>
            </section>

            {/* Phase 6 — Monitoring + Alerts */}
            <div className="dash-two">
              <MonitoringStatusCard
                monitoring={monitoring}
                loading={monitoringLoading}
                busy={monitoringBusy}
                onEnable={enableMonitoring}
                onPause={() => patchMonitoring({ action: "pause" })}
                onResume={() => patchMonitoring({ action: "resume" })}
                onRunNow={() => patchMonitoring({ action: "run_now" })}
              />
              <AlertCenter
                alerts={alerts}
                onMarkRead={markAlertsRead}
                onOpenAudit={(id) => {
                  setPhase("loading");
                  loadAudit(id, auditList)
                    .then(() => setPhase("ready"))
                    .catch((e) => {
                      setError(e.message);
                      setPhase("error");
                    });
                }}
              />
            </div>

            {/* Phase 5 — Opportunities + Before/After */}
            <div className="dash-two">
              <OpportunitiesPanel
                issues={diagnosis?.issues || []}
                summary={diagnosis?.summary}
                loading={diagnosisLoading}
                error={diagnosisError}
                onGenerateFix={generateFix}
                onGenerateActionPack={generateActionPack}
                packFixes={packFixes}
                packLoading={packLoading}
                onExplain={(issue) => {
                  const el = document.getElementById("competitor-intelligence");
                  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                  else setError(issue.description);
                }}
                activeFix={activeFix}
                fixLoadingId={fixLoadingId}
              />
              <BeforeAfterPanel comparison={comparison} />
            </div>

            {/* H trends */}
            <TrendChart trend={view.trend} />

            {/* E + F */}
            <div className="dash-two" id="competitor-intelligence">
              <CompetitorTable competitors={view.competitors} locked={view.competitors?.locked && !isPaid} />
              <PerceptionPanel perception={view.perception} />
            </div>

            {/* G + legacy actions */}
            <div className="dash-two">
              <WhatChanged whatChanged={view.whatChanged} />
              <ActionList actions={view.actions} />
            </div>

            {/* Questions (pro extended) */}
            <section style={{ ...panel(), position: "relative", overflow: view.gates?.extendedQuestions ? "visible" : "hidden" }}>
              <SectionTitle>Buyer questions in this audit</SectionTitle>
              <div style={{ display: "grid", gap: 8 }}>
                {(view.questions || []).slice(0, view.gates?.extendedQuestions ? 20 : 2).map((q) => (
                  <div key={q.id || q.question} style={{ fontSize: 13.5, padding: "10px 12px", background: "#fff", border: `1px solid ${C.border}`, borderRadius: 10 }}>
                    <span style={{ color: C.muted, fontSize: 11, fontWeight: 600, marginRight: 8 }}>{q.category}</span>
                    {q.question}
                  </div>
                ))}
              </div>
              {!view.gates?.extendedQuestions && (
                <div style={{ marginTop: 10, fontSize: 13, color: C.muted }}>
                  Free shows 2 questions. <a href="/pricing" style={{ color: C.violetDeep, fontWeight: 600 }}>Upgrade for the full set →</a>
                </div>
              )}
            </section>

            {/* Audit history */}
            <AuditHistory
              history={view.history}
              selectedId={view.selectedAuditId}
              onSelect={(id) => {
                setPhase("loading");
                loadAudit(id, auditList)
                  .then(() => setPhase("ready"))
                  .catch((e) => {
                    setError(e.message);
                    setPhase("error");
                  });
              }}
            />
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}

function SectionTitle({ children }) {
  return (
    <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 16, marginBottom: 10, color: C.ink }}>{children}</div>
  );
}

function PlanBadge({ plan }) {
  const pro = plan === "PRO";
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: 0.5,
        color: pro ? "#fff" : C.violetDeep,
        background: pro ? `linear-gradient(135deg,${C.violet},${C.violetDeep})` : "#ECEAFE",
        borderRadius: 999,
        padding: "4px 10px",
      }}
    >
      {plan}
    </span>
  );
}

function StateBox({ title, sub, action }) {
  return (
    <div style={{ ...panel(), textAlign: "center", padding: "48px 24px", maxWidth: 520, margin: "40px auto" }}>
      <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 24, marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 14.5, color: C.muted, lineHeight: 1.5, marginBottom: action ? 18 : 0 }}>{sub}</div>
      {action}
    </div>
  );
}

function panel() {
  return { background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 18 };
}

function primaryBtn() {
  return {
    padding: "11px 18px",
    borderRadius: 11,
    border: "none",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 14,
    color: "#fff",
    background: `linear-gradient(135deg,${C.violet},${C.violetDeep})`,
    textDecoration: "none",
    display: "inline-block",
  };
}

function ghostBtn() {
  return {
    padding: "11px 16px",
    borderRadius: 11,
    border: `1.5px solid ${C.border}`,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 14,
    color: C.ink,
    background: "#fff",
  };
}
