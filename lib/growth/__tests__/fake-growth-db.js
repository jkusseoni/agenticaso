import { createCampaignData, normalizeProspectIdentity } from "../persistence.js";

export function matchWhere(row, where) {
  if (!where) return true;
  if (where.AND && !where.AND.every((part) => matchWhere(row, part))) return false;
  if (where.OR && !where.OR.some((part) => matchWhere(row, part))) return false;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "AND" || key === "OR") continue;
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ("lte" in cond) {
        if (value == null) return false;
        if (new Date(value).getTime() > new Date(cond.lte).getTime()) return false;
        continue;
      }
      if ("in" in cond) {
        if (!cond.in.includes(value)) return false;
        continue;
      }
    }
    if (value !== cond) return false;
  }
  return true;
}

function applyData(row, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && Number.isFinite(value.increment)) {
      row[key] = (row[key] || 0) + value.increment;
    } else {
      row[key] = value;
    }
  }
  row.updatedAt = new Date();
}

function sortRows(rows, orderBy) {
  if (!orderBy) return rows;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      const [key, dir] = Object.entries(spec)[0];
      const av = a[key] == null ? 0 : a[key];
      const bv = b[key] == null ? 0 : b[key];
      if (av < bv) return dir === "desc" ? 1 : -1;
      if (av > bv) return dir === "desc" ? -1 : 1;
    }
    return 0;
  });
}

function applyInclude(row, include, state) {
  if (!row || !include) return row;
  const out = { ...row };
  if (include.reasons) {
    out.reasons = state.reasons.filter((r) => r.qualificationId === row.id).map((r) => {
      const reason = { ...r };
      if (include.reasons.include?.evidenceLinks) {
        reason.evidenceLinks = state.reasonEvidence.filter((x) => x.reasonId === r.id).map((x) => {
          const link = { ...x };
          if (include.reasons.include.evidenceLinks.include?.evidence) {
            link.evidence = state.evidence.find((e) => e.id === x.evidenceId) || null;
          }
          return link;
        });
      }
      return reason;
    });
  }
  return out;
}

export function createFakePrisma() {
  const state = {
    campaigns: [],
    prospects: [],
    jobs: [],
    evidence: [],
    qualifications: [],
    reasons: [],
    reasonEvidence: [],
    critics: [],
  };
  let n = 0;
  const id = (p) => `${p}_${++n}`;
  let chain = Promise.resolve();
  const serialized = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  const api = {
    state,
    async $transaction(fn) {
      const snap = structuredClone(state);
      try {
        return await fn(api);
      } catch (err) {
        state.campaigns = snap.campaigns;
        state.prospects = snap.prospects;
        state.jobs = snap.jobs;
        state.evidence = snap.evidence;
        state.qualifications = snap.qualifications;
        state.reasons = snap.reasons;
        state.reasonEvidence = snap.reasonEvidence;
        state.critics = snap.critics;
        throw err;
      }
    },
    growthCampaign: {
      async findUnique({ where }) {
        return state.campaigns.find((r) => r.id === where.id) || null;
      },
    },
    growthProspect: {
      async findUnique({ where }) {
        return state.prospects.find((r) => r.id === where.id) || null;
      },
      async update({ where, data }) {
        const row = state.prospects.find((r) => r.id === where.id);
        applyData(row, data);
        return row;
      },
    },
    growthJob: {
      async findUnique({ where }) {
        return state.jobs.find((r) => r.id === where.id) || null;
      },
      async findFirst({ where, orderBy }) {
        return sortRows(state.jobs.filter((r) => matchWhere(r, where)), orderBy)[0] || null;
      },
      async findMany({ where, orderBy, take } = {}) {
        const rows = sortRows(state.jobs.filter((r) => matchWhere(r, where)), orderBy);
        if (Number.isInteger(take) && take >= 0) return rows.slice(0, take);
        return rows;
      },
      async create({ data }) {
        const row = {
          id: data.id || id("job"),
          attempts: 0,
          status: "pending",
          claimedAt: null,
          leaseExpiresAt: null,
          finishedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.jobs.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = state.jobs.find((r) => r.id === where.id);
        applyData(row, data);
        return row;
      },
      async updateMany({ where, data }) {
        return serialized(() => {
          const rows = state.jobs.filter((r) => matchWhere(r, where));
          for (const row of rows) applyData(row, data);
          return { count: rows.length };
        });
      },
      async delete({ where }) {
        const row = state.jobs.find((r) => r.id === where.id);
        state.jobs = state.jobs.filter((r) => r.id !== where.id);
        for (const ev of state.evidence) {
          if (ev.jobId === where.id) ev.jobId = null;
        }
        for (const q of state.qualifications) {
          if (q.jobId === where.id) q.jobId = null;
        }
        return row;
      },
    },
    growthEvidence: {
      async findMany({ where }) {
        return state.evidence.filter((r) => matchWhere(r, where));
      },
      async create({ data }) {
        const dup = state.evidence.some(
          (e) => e.prospectId === data.prospectId && e.runId === data.runId && e.packEvidenceId === data.packEvidenceId
        );
        if (dup) {
          const err = new Error("Unique constraint failed");
          err.code = "P2002";
          throw err;
        }
        const row = { id: id("ev"), createdAt: new Date(), ...data };
        state.evidence.push(row);
        return row;
      },
    },
    growthQualification: {
      async findFirst({ where, orderBy, include }) {
        const row = sortRows(state.qualifications.filter((r) => matchWhere(r, where)), orderBy)[0] || null;
        return applyInclude(row, include, state);
      },
      async findUnique({ where, include }) {
        const row = state.qualifications.find((r) => r.id === where.id || (where.jobId && r.jobId === where.jobId)) || null;
        return applyInclude(row, include, state);
      },
      async create({ data }) {
        if (data.jobId && state.qualifications.some((q) => q.jobId === data.jobId)) {
          const err = new Error("Unique constraint failed");
          err.code = "P2002";
          throw err;
        }
        const row = { id: id("qual"), createdAt: new Date(), ...data };
        state.qualifications.push(row);
        return row;
      },
    },
    growthQualificationReason: {
      async create({ data }) {
        const row = { id: id("reason"), ...data };
        state.reasons.push(row);
        return row;
      },
    },
    growthQualificationReasonEvidence: {
      async create({ data }) {
        state.reasonEvidence.push(data);
        return data;
      },
    },
    growthCriticReview: {
      async findUnique({ where }) {
        return state.critics.find((r) => r.qualificationId === where.qualificationId || r.id === where.id) || null;
      },
      async create({ data }) {
        if (state.critics.some((c) => c.qualificationId === data.qualificationId)) {
          const err = new Error("Unique constraint failed");
          err.code = "P2002";
          throw err;
        }
        const row = { id: id("crit"), createdAt: new Date(), ...data };
        state.critics.push(row);
        return row;
      },
    },
  };

  api.seed = {
    campaign(overrides = {}) {
      const row = {
        id: id("camp"),
        ...createCampaignData(overrides.workspaceId || "ws1", {
          name: "CartRenew",
          productProfile: {
            product: {
              name: "CartRenew",
              url: "https://cartrenew.example",
              description: "Recover abandoned WooCommerce checkouts.",
            },
            targetPlatform: "woocommerce",
            goal: "find_stores",
            desiredSignals: ["checkout", "subscriptions"],
          },
        }),
        ...overrides,
      };
      state.campaigns.push(row);
      return row;
    },
    prospect(campaign, url = "https://shop.example/") {
      const identity = normalizeProspectIdentity(url);
      const row = {
        id: id("pros"),
        campaignId: campaign.id,
        originalUrl: identity.originalUrl,
        normalizedUrl: identity.normalizedUrl,
        canonicalDomain: identity.canonicalDomain,
        platformStatus: null,
        lifecycleState: "candidate",
        latestQualificationDecision: null,
        latestReviewState: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      state.prospects.push(row);
      return row;
    },
    job(campaign, prospect, type, extra = {}) {
      return api.growthJob.create({
        data: {
          campaignId: campaign.id,
          prospectId: prospect.id,
          type,
          status: extra.status || "pending",
          availableAt: extra.availableAt || new Date(),
          ...extra,
        },
      });
    },
  };
  return api;
}
