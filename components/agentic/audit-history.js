"use client";

import { C, DISPLAY, formatDate, scoreColor } from "@/lib/dashboard/theme";
import { card, eyebrow } from "./score-card";

export function AuditHistory({ history, selectedId, onSelect }) {
  const rows = history || [];
  return (
    <div style={card()}>
      <div style={eyebrow()}>Audit history</div>
      <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, marginBottom: 12 }}>Past intelligence runs</div>
      {!rows.length ? (
        <div style={{ fontSize: 14, color: C.muted }}>No saved audits yet.</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((h) => {
            const active = h.id === selectedId;
            return (
              <button
                key={h.id}
                type="button"
                onClick={() => onSelect?.(h.id)}
                style={{
                  textAlign: "left",
                  cursor: "pointer",
                  border: `1.5px solid ${active ? C.violet : C.border}`,
                  background: active ? "#F3F1FF" : "#fff",
                  borderRadius: 12,
                  padding: "12px 14px",
                  display: "grid",
                  gridTemplateColumns: "1.4fr repeat(3, .7fr) .6fr",
                  gap: 8,
                  alignItems: "center",
                  fontSize: 13,
                  color: C.ink,
                }}
              >
                <span>
                  <div style={{ fontWeight: 600 }}>{formatDate(h.date)}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>{h.domain || "—"}</div>
                </span>
                <span style={{ fontWeight: 700, color: scoreColor(h.overallScore) }}>
                  {h.overallScore == null ? "—" : Math.round(h.overallScore)}
                </span>
                <span>{h.mentionShare == null ? "—" : `${Math.round(h.mentionShare)}%`}</span>
                <span>{h.recommendationShare == null ? "—" : `${Math.round(h.recommendationShare)}%`}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.muted, textTransform: "uppercase" }}>{h.status}</span>
              </button>
            );
          })}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr repeat(3, .7fr) .6fr", gap: 8, padding: "8px 14px 0", fontSize: 11, color: C.muted }}>
        <span>Date</span><span>Score</span><span>SoV</span><span>Rec</span><span>Status</span>
      </div>
    </div>
  );
}

export function ActionList({ actions }) {
  const list = actions || [];
  return (
    <div style={card()}>
      <div style={eyebrow()}>What should I fix?</div>
      <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, marginBottom: 12 }}>Prioritized from this audit</div>
      {!list.length ? (
        <div style={{ fontSize: 14, color: C.muted }}>No actionable gaps detected from current evidence.</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {list.map((a, i) => (
            <div key={i} style={{ border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 14px", background: "#fff" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                <PriorityBadge level={a.priority} />
                <div style={{ fontWeight: 700, fontSize: 14.5 }}>{a.title}</div>
              </div>
              <div style={{ fontSize: 13.5, color: C.muted, lineHeight: 1.45 }}>{a.detail}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PriorityBadge({ level }) {
  const bg = level === "HIGH" ? "#FFE8E5" : level === "MEDIUM" ? "#FFF4DF" : "#EEF0F8";
  const color = level === "HIGH" ? C.coral : level === "MEDIUM" ? C.amber : C.muted;
  return (
    <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, color, background: bg, borderRadius: 999, padding: "3px 8px" }}>
      {level}
    </span>
  );
}

export function WhatChanged({ whatChanged }) {
  if (!whatChanged?.available) {
    return (
      <div style={card()}>
        <div style={eyebrow()}>What changed?</div>
        <div style={{ fontSize: 14.5, color: C.muted }}>{whatChanged?.message || "No previous audit to compare."}</div>
      </div>
    );
  }
  const share = whatChanged.share || {};
  const providers = whatChanged.providers || {};
  return (
    <div style={card()}>
      <div style={eyebrow()}>What changed?</div>
      <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, marginBottom: 12 }}>Movement since last audit</div>
      <div style={{ display: "grid", gap: 6, fontSize: 13.5 }}>
        <DeltaLine label="Mention share" delta={share.mentionShare?.delta} />
        <DeltaLine label="Recommendation share" delta={share.recommendationShare?.delta} />
        <DeltaLine label="Top-3 share" delta={share.top3Share?.delta} />
        <DeltaLine label="ChatGPT rec." delta={providers.openai?.delta} />
        <DeltaLine label="Perplexity rec." delta={providers.perplexity?.delta} />
        <DeltaLine label="Gemini rec." delta={providers.gemini?.delta} />
        <DeltaLine label="Agentic Score" delta={whatChanged.agenticScore?.overall?.delta} />
      </div>
    </div>
  );
}

function DeltaLine({ label, delta }) {
  const empty = delta == null;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", borderTop: `1px solid ${C.border}`, padding: "8px 0" }}>
      <span style={{ color: C.muted }}>{label}</span>
      <span style={{ fontWeight: 700, color: empty ? C.muted : delta >= 0 ? C.teal : C.coral }}>
        {empty ? "—" : `${delta > 0 ? "+" : ""}${delta}`}
      </span>
    </div>
  );
}
