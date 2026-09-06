import { ALERT_THRESHOLDS, ALERT_TYPES } from "./thresholds.js";

const PROVIDER_LABELS = { openai: "ChatGPT", perplexity: "Perplexity", gemini: "Gemini" };

/**
 * Build alerts from current vs previous completed audits.
 * Failed providers are excluded from provider-drop detection.
 *
 * @param {object} opts
 * @param {object} opts.current — completed audit (+ competitors, perception)
 * @param {object|null} opts.previous
 * @param {string} opts.websiteId
 * @param {string} [opts.auditId]
 * @param {string} [opts.monitoringId]
 */
export function buildMonitoringAlerts({ current, previous, websiteId, auditId, monitoringId }) {
  if (!current) return [];

  const alerts = [];
  const push = (partial) =>
    alerts.push({
      websiteId,
      auditId: auditId || current.id || null,
      monitoringId: monitoringId || null,
      read: false,
      ...partial,
    });

  if (!previous) {
    return alerts;
  }

  // Visibility drop / rise (mention share)
  const mentDelta = numDelta(current.mentionShare, previous.mentionShare);
  if (mentDelta != null && mentDelta <= -ALERT_THRESHOLDS.visibilityDropPp) {
    push({
      type: ALERT_TYPES.VISIBILITY_DROP,
      severity: "high",
      title: `AI visibility dropped ${Math.abs(Math.round(mentDelta))} points`,
      description: `AI Share of Voice moved from ${fmt(previous.mentionShare)}% to ${fmt(current.mentionShare)}%.`,
      data: { metric: "mentionShare", previous: previous.mentionShare, current: current.mentionShare, delta: mentDelta },
    });
  } else if (mentDelta != null && mentDelta >= ALERT_THRESHOLDS.visibilityRisePp) {
    push({
      type: ALERT_TYPES.VISIBILITY_RISE,
      severity: "info",
      title: `AI visibility increased ${Math.round(mentDelta)} points`,
      description: `AI Share of Voice moved from ${fmt(previous.mentionShare)}% to ${fmt(current.mentionShare)}%. Observed change after re-audit.`,
      data: { metric: "mentionShare", previous: previous.mentionShare, current: current.mentionShare, delta: mentDelta },
    });
  }

  // Provider drops — only when both sides have successful test evidence (tests > 0)
  const curP = current.providerMetrics || {};
  const prevP = previous.providerMetrics || {};
  for (const id of ["openai", "perplexity", "gemini"]) {
    const c = curP[id];
    const p = prevP[id];
    if (!c || !p) continue;
    if ((c.tests || 0) <= 0 || (p.tests || 0) <= 0) continue; // exclude failed/empty providers
    const d = numDelta(c.recommendationShare, p.recommendationShare);
    if (d != null && d <= -ALERT_THRESHOLDS.providerDropPp) {
      push({
        type: ALERT_TYPES.PROVIDER_DROP,
        severity: "high",
        title: `${PROVIDER_LABELS[id] || id} visibility dropped ${Math.abs(Math.round(d))} points`,
        description: `Recommendation share on ${PROVIDER_LABELS[id] || id} moved from ${fmt(p.recommendationShare)}% to ${fmt(c.recommendationShare)}%.`,
        data: { provider: id, previous: p.recommendationShare, current: c.recommendationShare, delta: d },
      });
    }
  }

  // Score change
  const scoreDelta = numDelta(current.overallScore, previous.overallScore);
  if (scoreDelta != null && Math.abs(scoreDelta) >= ALERT_THRESHOLDS.scoreChangePts) {
    push({
      type: ALERT_TYPES.SCORE_CHANGE,
      severity: scoreDelta < 0 ? "medium" : "info",
      title: `Agentic Score ${scoreDelta < 0 ? "dropped" : "rose"} ${Math.abs(Math.round(scoreDelta))} points`,
      description: `Overall score moved from ${fmt(previous.overallScore)} to ${fmt(current.overallScore)}.`,
      data: { previous: previous.overallScore, current: current.overallScore, delta: scoreDelta },
    });
  }

  // Competitor movement
  const curComps = indexByName(current.competitors || current.topCompetitors || []);
  const prevComps = indexByName(previous.competitors || previous.topCompetitors || []);
  const targetRec = current.recommendationShare ?? 0;
  const prevTargetRec = previous.recommendationShare ?? 0;

  for (const [key, comp] of curComps) {
    const prev = prevComps.get(key);
    const cRec = comp.recommendationShare;
    if (cRec == null) continue;

    // Overtake: competitor was at/below target, now above (or gap flipped)
    const wasAhead = prev && prev.recommendationShare != null ? prev.recommendationShare > prevTargetRec : false;
    const nowAhead = cRec > targetRec;
    if (nowAhead && !wasAhead) {
      push({
        type: ALERT_TYPES.COMPETITOR_OVERTAKE,
        severity: "high",
        title: `${comp.name} overtook you`,
        description: `${comp.name} recommendation share is ${fmt(cRec)}% vs your ${fmt(targetRec)}%.`,
        data: { competitor: comp.name, competitorShare: cRec, targetShare: targetRec },
      });
    }

    if (prev && prev.recommendationShare != null) {
      const gapNow = targetRec - cRec;
      const gapPrev = prevTargetRec - prev.recommendationShare;
      const gapDelta = gapNow - gapPrev;
      if (gapDelta <= -10) {
        push({
          type: ALERT_TYPES.GAP_WIDENING,
          severity: "medium",
          title: `Gap vs ${comp.name} widened`,
          description: `Recommendation gap moved from ${fmt(gapPrev)} to ${fmt(gapNow)} pp.`,
          data: { competitor: comp.name, gapPrevious: gapPrev, gapCurrent: gapNow, delta: gapDelta },
        });
      } else if (gapDelta >= 10) {
        push({
          type: ALERT_TYPES.GAP_SHRINKING,
          severity: "info",
          title: `Gap vs ${comp.name} improved`,
          description: `Recommendation gap moved from ${fmt(gapPrev)} to ${fmt(gapNow)} pp.`,
          data: { competitor: comp.name, gapPrevious: gapPrev, gapCurrent: gapNow, delta: gapDelta },
        });
      }
    } else if (!prev) {
      push({
        type: ALERT_TYPES.NEW_COMPETITOR,
        severity: "medium",
        title: `New competitor detected: ${comp.name}`,
        description: `${comp.name} appeared in AI recommendations (${fmt(cRec)}% recommendation share).`,
        data: { competitor: comp.name, recommendationShare: cRec },
      });
    }
  }

  // Perception change — only if both have theme arrays
  const curMiss = new Set(current.perception?.missingThemes || current.intelligenceSummary?.perception?.missingThemes || []);
  const prevMiss = new Set(previous.perception?.missingThemes || previous.intelligenceSummary?.perception?.missingThemes || []);
  if (curMiss.size || prevMiss.size) {
    const added = [...curMiss].filter((t) => !prevMiss.has(t));
    const removed = [...prevMiss].filter((t) => !curMiss.has(t));
    if (added.length || removed.length) {
      push({
        type: ALERT_TYPES.PERCEPTION_CHANGE,
        severity: added.length ? "medium" : "info",
        title: "AI perception themes changed",
        description: [
          added.length ? `New missing themes: ${added.join(", ")}.` : null,
          removed.length ? `Resolved missing themes: ${removed.join(", ")}.` : null,
        ]
          .filter(Boolean)
          .join(" "),
        data: { addedMissing: added, removedMissing: removed },
      });
    }
  }

  return alerts;
}

function numDelta(cur, prev) {
  if (cur == null || prev == null) return null;
  const a = Number(cur);
  const b = Number(prev);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) * 10) / 10;
}

function fmt(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return String(Math.round(Number(v)));
}

function indexByName(list) {
  const map = new Map();
  for (const c of list || []) {
    const name = String(c?.name || "").trim();
    if (!name) continue;
    map.set(name.toLowerCase(), c);
  }
  return map;
}
