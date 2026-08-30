"use client";

import { C, DISPLAY, BODY } from "@/lib/dashboard/theme";
import { card, eyebrow, ProLock } from "./score-card";

export function CompetitorTable({ competitors, locked }) {
  const rows = competitors?.rows || [];
  return (
    <div style={{ ...card(), position: "relative", overflow: locked ? "hidden" : "visible" }}>
      <div style={eyebrow()}>Competitor intelligence</div>
      <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, marginBottom: 12 }}>
        {competitors?.brand || "Your brand"} vs AI-recommended rivals
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
          <thead>
            <tr style={{ textAlign: "left", color: C.muted }}>
              <th style={th()}>Brand</th>
              <th style={th()}>Rec. share</th>
              <th style={th()}>Top 3</th>
              <th style={th()}>Gap</th>
              <th style={th()}>Why they&apos;re ahead</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} style={{ borderTop: `1px solid ${C.border}`, background: r.isTarget ? "#F3F1FF" : "transparent" }}>
                <td style={td()}>
                  <strong>{r.name}</strong>
                  {r.isTarget ? <span style={{ marginLeft: 8, fontSize: 11, color: C.violet }}>YOU</span> : null}
                </td>
                <td style={td()}>{pct(r.recommendationShare)}</td>
                <td style={td()}>{pct(r.top3Share)}</td>
                <td style={td()}>
                  {r.isTarget ? "—" : r.gap == null ? "—" : (
                    <span style={{ color: r.gap >= 0 ? C.teal : C.coral, fontWeight: 600 }}>
                      {r.gap > 0 ? "+" : ""}{r.gap}
                    </span>
                  )}
                </td>
                <td style={{ ...td(), color: C.muted, maxWidth: 280 }}>
                  {r.isTarget ? "—" : (r.whyAhead || []).slice(0, 2).join(" ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {locked && <ProLock />}
    </div>
  );
}

function pct(v) {
  return v == null ? "—" : `${Math.round(v)}%`;
}
function th() {
  return { padding: "8px 10px", fontWeight: 600, fontSize: 12 };
}
function td() {
  return { padding: "11px 10px", color: C.ink, fontFamily: BODY, verticalAlign: "top" };
}
