/**
 * Pure historical comparison helpers (no DB required).
 */

function metricDelta(current, previous) {
  const c = current == null ? null : Number(current);
  const p = previous == null ? null : Number(previous);
  if (c == null || p == null || Number.isNaN(c) || Number.isNaN(p)) {
    return { current: c, previous: p, delta: null };
  }
  return { current: c, previous: p, delta: Math.round((c - p) * 10) / 10 };
}

/**
 * Compare two completed audit metric snapshots.
 * @param {object} current
 * @param {object} previous
 */
export function compareAudits(current, previous) {
  if (!current) {
    return { error: "Current audit required.", current: null, previous: null, delta: null };
  }
  if (!previous) {
    return {
      current: summarizeAudit(current),
      previous: null,
      delta: null,
      missingPrevious: true,
      message: "No previous completed audit to compare.",
    };
  }

  const share = {
    mentionShare: metricDelta(current.mentionShare, previous.mentionShare),
    recommendationShare: metricDelta(current.recommendationShare, previous.recommendationShare),
    top3Share: metricDelta(current.top3Share, previous.top3Share),
  };

  const providers = compareProviderMetrics(current.providerMetrics, previous.providerMetrics);

  const agenticScore = {
    found: metricDelta(current.foundScore, previous.foundScore),
    understood: metricDelta(current.understoodScore, previous.understoodScore),
    recommended: metricDelta(current.recommendedScore, previous.recommendedScore),
    bought: metricDelta(current.boughtScore, previous.boughtScore),
    overall: metricDelta(current.overallScore, previous.overallScore),
  };

  const competitors = compareCompetitorSnapshots(
    current.competitors || [],
    previous.competitors || [],
    current.recommendationShare
  );

  return {
    current: summarizeAudit(current),
    previous: summarizeAudit(previous),
    delta: { share, providers, agenticScore, competitors },
    missingPrevious: false,
  };
}

export function compareProviderMetrics(current = {}, previous = {}) {
  const ids = ["openai", "perplexity", "gemini"];
  /** @type {Record<string, object>} */
  const out = {};
  for (const id of ids) {
    const c = current?.[id] || {};
    const p = previous?.[id] || {};
    out[id] = {
      mentionShare: metricDelta(c.mentionShare, p.mentionShare),
      recommendationShare: metricDelta(c.recommendationShare, p.recommendationShare),
      top3Share: metricDelta(c.top3Share, p.top3Share),
      // Convenience: recommendation movement as primary provider delta
      previous: p.recommendationShare ?? null,
      current: c.recommendationShare ?? null,
      delta:
        c.recommendationShare != null && p.recommendationShare != null
          ? Math.round((c.recommendationShare - p.recommendationShare) * 10) / 10
          : null,
    };
  }
  return out;
}

/**
 * @param {Array<{ name: string, recommendationShare?: number|null, mentionShare?: number|null }>} currentList
 * @param {Array<{ name: string, recommendationShare?: number|null, mentionShare?: number|null }>} previousList
 * @param {number|null} [targetCurrentShare]
 */
export function compareCompetitorSnapshots(currentList, previousList, targetCurrentShare = null) {
  const prevMap = new Map(
    (previousList || []).map((c) => [String(c.name).toLowerCase(), c])
  );
  const currMap = new Map(
    (currentList || []).map((c) => [String(c.name).toLowerCase(), c])
  );

  const names = new Set([...prevMap.keys(), ...currMap.keys()]);
  const rows = [];

  for (const key of names) {
    const cur = currMap.get(key);
    const prev = prevMap.get(key);
    const name = cur?.name || prev?.name;
    const previousShare = prev?.recommendationShare ?? null;
    const currentShare = cur?.recommendationShare ?? null;
    const target = targetCurrentShare;
    const gapCurrent =
      target != null && currentShare != null ? Math.round((target - currentShare) * 10) / 10 : null;
    const gapPrevious =
      target != null && previousShare != null
        ? null // target previous not passed — gap change uses competitor share delta
        : null;
    const shareDelta =
      currentShare != null && previousShare != null
        ? Math.round((currentShare - previousShare) * 10) / 10
        : null;

    rows.push({
      competitor: name,
      previousRecommendationShare: previousShare,
      currentRecommendationShare: currentShare,
      recommendationShareDelta: shareDelta,
      targetRecommendationShare: target,
      gapCurrent,
      gapChange: shareDelta == null ? null : -shareDelta, // target gap improves when competitor share drops
    });
  }

  return rows.sort(
    (a, b) =>
      (b.currentRecommendationShare ?? -1) - (a.currentRecommendationShare ?? -1) ||
      (b.previousRecommendationShare ?? -1) - (a.previousRecommendationShare ?? -1)
  );
}

function summarizeAudit(a) {
  return {
    id: a.id,
    websiteId: a.websiteId,
    status: a.status,
    completedAt: a.completedAt,
    mentionShare: a.mentionShare,
    recommendationShare: a.recommendationShare,
    top3Share: a.top3Share,
    providerMetrics: a.providerMetrics || null,
    agenticScore: {
      found: { score: a.foundScore, status: a.foundStatus },
      understood: { score: a.understoodScore, status: a.understoodStatus },
      recommended: { score: a.recommendedScore, status: a.recommendedStatus },
      bought: { score: a.boughtScore, status: a.boughtStatus },
      overall: { score: a.overallScore, status: a.overallStatus },
    },
  };
}

export { metricDelta };
