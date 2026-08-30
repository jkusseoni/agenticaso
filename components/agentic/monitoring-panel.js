"use client";

import { C, DISPLAY, formatDate } from "@/lib/dashboard/theme";
import { card, eyebrow } from "./score-card";

export function MonitoringStatusCard({
  monitoring,
  loading,
  onPause,
  onResume,
  onRunNow,
  onEnable,
  busy,
}) {
  if (loading) {
    return (
      <div style={card()}>
        <div style={eyebrow()}>AI Monitoring</div>
        <div style={{ fontSize: 14, color: C.muted }}>Loading…</div>
      </div>
    );
  }

  if (!monitoring) {
    return (
      <div style={card()}>
        <div style={eyebrow()}>AI Monitoring</div>
        <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, marginBottom: 8 }}>Not configured</div>
        <div style={{ fontSize: 14, color: C.muted, marginBottom: 12, lineHeight: 1.45 }}>
          Enable weekly monitoring to track AI visibility changes automatically.
        </div>
        <button type="button" onClick={onEnable} disabled={busy} style={btn()}>
          Enable weekly monitoring
        </button>
      </div>
    );
  }

  const active = monitoring.active;
  return (
    <div style={card()}>
      <div style={eyebrow()}>AI Monitoring</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 18 }}>{active ? "🟢" : "⏸️"}</span>
        <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18 }}>
          {active ? "Active" : "Paused"}
        </span>
      </div>
      <div style={{ fontSize: 13.5, color: C.muted, marginBottom: 4 }}>
        {String(monitoring.frequency || "weekly").replace(/^./, (c) => c.toUpperCase())}
      </div>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 4 }}>
        Last checked: {formatDate(monitoring.lastRunAt)}
      </div>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
        Next check: {formatDate(monitoring.nextRunAt)}
      </div>
      {monitoring.lastStatus && (
        <div style={{ fontSize: 12.5, color: monitoring.lastStatus === "failed" ? C.coral : C.muted, marginBottom: 12 }}>
          Last status: {monitoring.lastStatus}
          {monitoring.lastError ? ` — ${monitoring.lastError}` : ""}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {active ? (
          <button type="button" onClick={onPause} disabled={busy} style={btnGhost()}>Pause</button>
        ) : (
          <button type="button" onClick={onResume} disabled={busy} style={btnGhost()}>Resume</button>
        )}
        <button type="button" onClick={onRunNow} disabled={busy || !active} style={btn()}>
          {busy ? "Running…" : "Run Now"}
        </button>
      </div>
    </div>
  );
}

export function AlertCenter({ alerts, onOpenAudit, onMarkRead }) {
  const list = alerts || [];
  return (
    <div style={card()}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <div>
          <div style={eyebrow()}>Alerts</div>
          <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18 }}>Alert center</div>
        </div>
        {list.some((a) => !a.read) && (
          <button type="button" onClick={onMarkRead} style={btnGhost()}>Mark all read</button>
        )}
      </div>
      {!list.length ? (
        <div style={{ fontSize: 14, color: C.muted }}>No monitoring alerts yet.</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {list.slice(0, 12).map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => a.auditId && onOpenAudit?.(a.auditId)}
              style={{
                textAlign: "left",
                cursor: a.auditId ? "pointer" : "default",
                border: `1px solid ${C.border}`,
                background: a.read ? "#fff" : "#F7F7FC",
                borderRadius: 12,
                padding: "11px 13px",
              }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                <span>{severityIcon(a.severity, a.type)}</span>
                <span style={{ fontWeight: 700, fontSize: 13.5, color: C.ink }}>{a.title}</span>
              </div>
              <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.4 }}>{a.description}</div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 6 }}>
                {formatDate(a.createdAt)}
                {a.website?.domain ? ` · ${a.website.domain}` : ""}
                {a.auditId ? " · View audit" : ""}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function severityIcon(severity, type) {
  if (type === "visibility_rise" || type === "gap_shrinking") return "🟢";
  if (severity === "high" || severity === "critical") return "🔴";
  if (severity === "medium") return "🟡";
  return "🟢";
}

function btn() {
  return {
    padding: "9px 14px",
    borderRadius: 10,
    border: "none",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
    color: "#fff",
    background: `linear-gradient(135deg,${C.violet},${C.violetDeep})`,
  };
}
function btnGhost() {
  return {
    padding: "9px 14px",
    borderRadius: 10,
    border: `1.5px solid ${C.border}`,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
    color: C.ink,
    background: "#fff",
  };
}
