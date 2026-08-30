"use client";

import { C, DISPLAY, BODY, scoreColor, formatDelta } from "@/lib/dashboard/theme";

export function ScoreCard({ score, status, delta, title = "Agentic Score" }) {
  const color = scoreColor(score);
  const d = formatDelta(delta);
  return (
    <div style={card()}>
      <div style={eyebrow()}>{title}</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
        <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 56, lineHeight: 1, color: score == null ? C.muted : color }}>
          {score == null ? "—" : Math.round(score)}
          {score != null && <span style={{ fontSize: 20, color: C.muted }}> / 100</span>}
        </div>
        <div style={{ paddingBottom: 8 }}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 4 }}>
            {status === "not_evaluated" ? "Not fully evaluated" : status === "ok" ? "Evaluated" : status || "—"}
          </div>
          {d != null ? (
            <div style={{ fontSize: 14, fontWeight: 700, color: Number(delta) >= 0 ? C.teal : C.coral }}>
              {d} vs previous
            </div>
          ) : (
            <div style={{ fontSize: 13, color: C.muted }}>No prior audit for delta</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function MetricCard({ label, value, delta, suffix = "%" }) {
  const d = formatDelta(delta);
  return (
    <div style={card()}>
      <div style={eyebrow()}>{label}</div>
      <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 32, color: C.ink, letterSpacing: -0.5 }}>
        {value == null ? "—" : `${Math.round(value)}${suffix}`}
      </div>
      {d != null ? (
        <div style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: Number(delta) >= 0 ? C.teal : C.coral }}>{d} pts</div>
      ) : (
        <div style={{ marginTop: 6, fontSize: 12.5, color: C.muted }}>No change data</div>
      )}
    </div>
  );
}

export function ProviderCard({ provider, locked }) {
  if (locked) {
    return (
      <div style={{ ...card(), position: "relative", overflow: "hidden", minHeight: 140 }}>
        <div style={eyebrow()}>{provider.label}</div>
        <div style={{ fontSize: 14, color: C.muted, marginTop: 8 }}>Pro unlocks full provider breakdown</div>
        <ProLock />
      </div>
    );
  }

  const status = provider.failed
    ? "Provider failed — others still counted"
    : provider.partialFailure
      ? "Partial failures on some questions"
      : provider.unavailable
        ? "No tests in this audit"
        : `${provider.tests || 0} tests`;

  return (
    <div style={card()}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
        <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 17 }}>{provider.label}</div>
        <div style={{ fontSize: 12, color: provider.failed ? C.coral : C.muted }}>{status}</div>
      </div>
      <Row label="Share" value={provider.mentionShare} delta={provider.delta?.mentionShare} />
      <Row label="Recommended" value={provider.recommendationShare} delta={provider.delta?.recommendationShare} />
      <Row label="Top 3" value={provider.top3Share} delta={provider.delta?.top3Share} />
    </div>
  );
}

function Row({ label, value, delta }) {
  const d = formatDelta(delta);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "6px 0", borderTop: `1px solid ${C.border}` }}>
      <span style={{ color: C.muted }}>{label}</span>
      <span style={{ fontWeight: 600, color: C.ink }}>
        {value == null ? "—" : `${Math.round(value)}%`}
        {d != null && (
          <span style={{ marginLeft: 8, color: Number(delta) >= 0 ? C.teal : C.coral, fontWeight: 600 }}>{d}</span>
        )}
      </span>
    </div>
  );
}

export function ProLock() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "linear-gradient(180deg, rgba(245,246,251,.2), rgba(245,246,251,.92))",
        display: "grid",
        placeItems: "center",
        textAlign: "center",
        padding: 16,
      }}
    >
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.violet, letterSpacing: 0.5, marginBottom: 6 }}>PRO</div>
        <a href="/pricing" style={{ fontSize: 13.5, fontWeight: 600, color: C.violetDeep, textDecoration: "underline" }}>
          Upgrade to unlock →
        </a>
      </div>
    </div>
  );
}

export function card() {
  return {
    background: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 16,
    padding: 18,
    fontFamily: BODY,
  };
}

export function eyebrow() {
  return {
    fontSize: 11.5,
    fontWeight: 600,
    color: C.muted,
    letterSpacing: 0.5,
    marginBottom: 8,
    textTransform: "uppercase",
  };
}
