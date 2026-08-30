"use client";

import { C, DISPLAY } from "@/lib/dashboard/theme";
import { card, eyebrow, ProLock } from "./score-card";

/**
 * Lightweight SVG trend — no chart library. Empty / locked states supported.
 */
export function TrendChart({ trend }) {
  if (trend?.locked) {
    return (
      <div style={{ ...card(), position: "relative", overflow: "hidden", minHeight: 180 }}>
        <div style={eyebrow()}>Visibility trends</div>
        <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, marginBottom: 8 }}>Historical movement</div>
        <div style={{ fontSize: 14, color: C.muted }}>Pro unlocks Agentic Score, SoV, and recommendation trends.</div>
        <ProLock />
      </div>
    );
  }

  if (!trend?.available) {
    return (
      <div style={card()}>
        <div style={eyebrow()}>Visibility trends</div>
        <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, marginBottom: 8 }}>Historical movement</div>
        <div style={{ fontSize: 14.5, color: C.muted, lineHeight: 1.5 }}>
          {trend?.message || "Run another audit to unlock visibility trends."}
        </div>
      </div>
    );
  }

  const points = trend.points || [];
  return (
    <div style={card()}>
      <div style={eyebrow()}>Visibility trends</div>
      <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, marginBottom: 14 }}>Score & share over time</div>
      <MiniLine label="Agentic Score" color={C.violet} values={points.map((p) => p.overallScore)} />
      <MiniLine label="AI Share of Voice" color={C.teal} values={points.map((p) => p.mentionShare)} />
      <MiniLine label="Recommendation Share" color={C.amber} values={points.map((p) => p.recommendationShare)} />
      <div style={{ fontSize: 12.5, fontWeight: 600, color: C.muted, margin: "8px 0 6px" }}>Provider recommendation trends</div>
      <MiniLine label="ChatGPT" color={C.violetDeep} values={points.map((p) => p.openaiRec)} />
      <MiniLine label="Perplexity" color="#0EA5E9" values={points.map((p) => p.perplexityRec)} />
      <MiniLine label="Gemini" color="#EA4335" values={points.map((p) => p.geminiRec)} />
      <div style={{ marginTop: 8, fontSize: 12, color: C.muted }}>{points.length} completed audits</div>
    </div>
  );
}

function MiniLine({ label, color, values }) {
  const nums = values.map((v) => (v == null ? null : Number(v)));
  const known = nums.filter((v) => v != null);
  const max = Math.max(100, ...(known.length ? known : [100]));
  const w = 280;
  const h = 48;
  const coords = nums
    .map((v, i) => {
      if (v == null) return null;
      const x = nums.length <= 1 ? w / 2 : (i / (nums.length - 1)) * w;
      const y = h - (v / max) * (h - 4) - 2;
      return `${x},${y}`;
    })
    .filter(Boolean)
    .join(" ");

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
        <span style={{ color: C.muted }}>{label}</span>
        <span style={{ fontWeight: 600, color }}>{known.length ? `${Math.round(known[known.length - 1])}` : "—"}</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ maxWidth: 420, background: "#F7F7FC", borderRadius: 8 }}>
        {coords && <polyline fill="none" stroke={color} strokeWidth="2.5" points={coords} />}
      </svg>
    </div>
  );
}
