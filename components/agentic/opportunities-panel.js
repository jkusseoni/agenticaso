"use client";

import { C, DISPLAY } from "@/lib/dashboard/theme";
import { card, eyebrow } from "./score-card";

export function OpportunitiesPanel({
  issues = [],
  summary,
  loading,
  error,
  onGenerateFix,
  onGenerateActionPack,
  onExplain,
  activeFix,
  fixLoadingId,
  packFixes = [],
  packLoading,
}) {
  return (
    <div style={card()}>
      <div style={eyebrow()}>AI Opportunities</div>
      <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, marginBottom: 8 }}>
        Evidence-based diagnosis
      </div>
      {summary && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12, fontSize: 12.5 }}>
          {["critical", "high", "medium", "low"].map((k) => (
            <span key={k} style={{ background: "#F3F3FA", border: `1px solid ${C.border}`, borderRadius: 999, padding: "4px 10px", color: C.muted }}>
              {k}: <b style={{ color: C.ink }}>{summary[k] || 0}</b>
            </span>
          ))}
        </div>
      )}
      <ActionPack
        fixes={packFixes}
        loading={packLoading}
        onGenerate={onGenerateActionPack}
      />
      {loading && <div style={{ fontSize: 14, color: C.muted }}>Diagnosing audit…</div>}
      {error && <div style={{ fontSize: 13.5, color: C.coral }}>{error}</div>}
      {!loading && !error && !issues.length && (
        <div style={{ fontSize: 14, color: C.muted }}>No evidence-backed issues detected for this audit.</div>
      )}
      <div style={{ display: "grid", gap: 10 }}>
        {issues.slice(0, 5).map((issue) => (
          <div key={issue.id} style={{ border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 14px", background: "#fff" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <Priority level={issue.priority} />
              <span style={{ fontSize: 11, fontWeight: 600, color: C.muted, textTransform: "uppercase" }}>{issue.category}</span>
            </div>
            <div style={{ fontWeight: 700, fontSize: 14.5, marginBottom: 4 }}>{issue.title}</div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.45, marginBottom: 8 }}>{issue.description}</div>
            <details style={{ fontSize: 12.5, color: C.muted, marginBottom: 10 }}>
              <summary style={{ cursor: "pointer", fontWeight: 600, color: C.violetDeep }}>Evidence</summary>
              <ul style={{ margin: "8px 0 0 18px" }}>
                {(issue.evidence || []).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </details>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => onGenerateFix?.(issue)}
                disabled={fixLoadingId === issue.id}
                style={btn()}
              >
                {fixLoadingId === issue.id ? "Generating…" : "Generate Fix"}
              </button>
              {issue.id.startsWith("competitor_gap") && (
                <button type="button" onClick={() => onExplain?.(issue)} style={btnGhost()}>
                  Why?
                </button>
              )}
            </div>
            {activeFix?.issueId === issue.id && activeFix.fix && (
              <FixDetail fix={activeFix.fix} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ActionPack({ fixes = [], loading, onGenerate }) {
  const pack = (fixes || []).filter((f) =>
    ["STRUCTURED_DATA", "LLMS_TXT", "FAQ", "META_TAGS"].includes(f.category)
  );
  return (
    <div style={{ margin: "0 0 14px", padding: 12, borderRadius: 12, border: `1px dashed ${C.border}`, background: "#FAFAFE" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between", marginBottom: pack.length ? 10 : 0 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Action pack</div>
          <div style={{ fontSize: 12.5, color: C.muted }}>JSON-LD, llms.txt, FAQ, and meta drafts. Review before publishing.</div>
        </div>
        <button type="button" onClick={() => onGenerate?.()} disabled={loading} style={btn()}>
          {loading ? "Generating…" : pack.length ? "Regenerate pack" : "Generate action pack"}
        </button>
      </div>
      {pack.map((fix) => (
        <details key={fix.id || fix.category} style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13, color: C.violetDeep }}>
            {fix.title} <span style={{ fontWeight: 500, color: C.muted, fontSize: 11 }}>{fix.language}</span>
          </summary>
          <div style={{ fontSize: 12.5, color: C.muted, margin: "6px 0 8px" }}>{fix.description}</div>
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, color: C.ink }}>
            {fix.codeSnippet || ""}
          </pre>
        </details>
      ))}
    </div>
  );
}

function FixDetail({ fix }) {
  const body = fix.suggestedContent?.body || fix.codeSnippet || "";
  return (
    <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: "#F7F7FC", border: `1px solid ${C.border}` }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: C.amber, letterSpacing: 0.4, marginBottom: 6 }}>
        {fix.disclaimer || "Suggested — review before publishing."}
      </div>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{fix.title}</div>
      {fix.why && (
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}><b style={{ color: C.ink }}>Why:</b> {fix.why}</div>
      )}
      {fix.expectedImpact && (
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}><b style={{ color: C.ink }}>Expected impact:</b> {fix.expectedImpact}</div>
      )}
      {fix.implementationSteps?.length > 0 && (
        <>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>Implementation</div>
          <ol style={{ margin: "0 0 10px 18px", fontSize: 13, color: C.ink, lineHeight: 1.45 }}>
            {fix.implementationSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </>
      )}
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
        {fix.codeSnippet && !fix.suggestedContent?.body ? `Snippet (${fix.language || "text"})` : "Suggested content"}
      </div>
      <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 12.5, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, marginBottom: 10, color: C.ink }}>
        {body}
      </pre>
      {fix.verificationPlan?.length > 0 && (
        <>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>Verification</div>
          <ul style={{ margin: "0 0 0 18px", fontSize: 13, color: C.muted }}>
            {fix.verificationPlan.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function BeforeAfterPanel({ comparison, label = "Observed change after re-audit." }) {
  if (!comparison || comparison.missingPrevious || !comparison.delta) {
    return (
      <div style={card()}>
        <div style={eyebrow()}>Before / After</div>
        <div style={{ fontSize: 14, color: C.muted }}>Run another audit (Re-audit) to unlock before/after comparison.</div>
      </div>
    );
  }

  const share = comparison.delta.share || {};
  const providers = comparison.delta.providers || {};
  const cur = comparison.current || {};
  const prev = comparison.previous || {};

  return (
    <div style={card()}>
      <div style={eyebrow()}>Before / After</div>
      <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, marginBottom: 6 }}>Re-audit comparison</div>
      <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>{label} Causation is not assumed.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10, marginBottom: 14 }}>
        <Stat title="BEFORE AI SoV" value={pct(prev.mentionShare)} />
        <Stat title="AFTER AI SoV" value={pct(cur.mentionShare)} />
        <Stat title="CHANGE" value={delta(share.mentionShare?.delta)} good={share.mentionShare?.delta} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10, marginBottom: 14 }}>
        <Stat title="BEFORE Rec" value={pct(prev.recommendationShare)} />
        <Stat title="AFTER Rec" value={pct(cur.recommendationShare)} />
        <Stat title="CHANGE" value={delta(share.recommendationShare?.delta)} good={share.recommendationShare?.delta} />
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: C.muted, marginBottom: 6 }}>Provider movement (recommendation)</div>
      <div style={{ display: "grid", gap: 6, fontSize: 13.5 }}>
        <Prov name="ChatGPT" d={providers.openai} />
        <Prov name="Perplexity" d={providers.perplexity} />
        <Prov name="Gemini" d={providers.gemini} />
      </div>
    </div>
  );
}

function Prov({ name, d }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", borderTop: `1px solid ${C.border}`, padding: "7px 0" }}>
      <span style={{ color: C.muted }}>{name}</span>
      <span style={{ fontWeight: 600 }}>
        {d?.previous == null ? "—" : `${Math.round(d.previous)}%`}
        {" → "}
        {d?.current == null ? "—" : `${Math.round(d.current)}%`}
        <span style={{ marginLeft: 8, color: d?.delta == null ? C.muted : d.delta >= 0 ? C.teal : C.coral }}>
          {d?.delta == null ? "" : `${d.delta > 0 ? "+" : ""}${d.delta}`}
        </span>
      </span>
    </div>
  );
}

function Stat({ title, value, good }) {
  return (
    <div style={{ background: "#F7F7FC", borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: C.muted, marginBottom: 4 }}>{title}</div>
      <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 22, color: good == null ? C.ink : good >= 0 ? C.teal : C.coral }}>
        {value}
      </div>
    </div>
  );
}

function Priority({ level }) {
  const bg = level === "critical" || level === "high" ? "#FFE8E5" : level === "medium" ? "#FFF4DF" : "#EEF0F8";
  const color = level === "critical" || level === "high" ? C.coral : level === "medium" ? C.amber : C.muted;
  return (
    <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, color, background: bg, borderRadius: 999, padding: "3px 8px", textTransform: "uppercase" }}>
      {level}
    </span>
  );
}

function pct(v) {
  return v == null ? "—" : `${Math.round(v)}%`;
}
function delta(v) {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v} points`;
}
function btn() {
  return {
    padding: "8px 12px",
    borderRadius: 9,
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
    padding: "8px 12px",
    borderRadius: 9,
    border: `1.5px solid ${C.border}`,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
    color: C.ink,
    background: "#fff",
  };
}
