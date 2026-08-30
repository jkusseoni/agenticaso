"use client";

import { C, DISPLAY } from "@/lib/dashboard/theme";
import { card, eyebrow, ProLock } from "./score-card";

export function PerceptionPanel({ perception }) {
  const locked = perception?.locked;
  return (
    <div style={{ ...card(), position: "relative", overflow: locked ? "hidden" : "visible" }}>
      <div style={eyebrow()}>AI perception</div>
      <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, marginBottom: 12 }}>What AI associates with you</div>
      <ThemeGroup title="Understood themes" items={perception?.aiThemes || []} tone="teal" />
      <ThemeGroup title="Missing themes" items={perception?.missingThemes || []} tone="coral" />
      <ThemeGroup title="Unexpected themes" items={perception?.unexpectedThemes || []} tone="amber" />
      {perception?.method && (
        <div style={{ marginTop: 10, fontSize: 12, color: C.muted }}>
          Method: {perception.method} — keyword heuristics, not LLM judgment.
        </div>
      )}
      {locked && <ProLock />}
    </div>
  );
}

function ThemeGroup({ title, items, tone }) {
  const color = tone === "teal" ? C.teal : tone === "coral" ? C.coral : C.amber;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: C.muted, marginBottom: 6 }}>{title}</div>
      {!(items || []).length ? (
        <div style={{ fontSize: 13, color: C.muted }}>None detected</div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {items.map((t) => (
            <span
              key={t}
              style={{
                fontSize: 12.5,
                fontWeight: 500,
                border: `1px solid ${C.border}`,
                background: "#fff",
                borderRadius: 999,
                padding: "5px 11px",
                color: C.ink,
                boxShadow: `inset 3px 0 0 ${color}`,
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
