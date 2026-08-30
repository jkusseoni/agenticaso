/**
 * Buyer question persistence + light categorization.
 */

const CATEGORY_RULES = [
  { category: "discovery", re: /\b(what is|who makes|best|top|find|discover|looking for)\b/i },
  { category: "comparison", re: /\b(vs|versus|compare|comparison|better than|alternative to)\b/i },
  { category: "problem", re: /\b(problem|issue|fix|how to|help with|struggling)\b/i },
  { category: "alternative", re: /\b(alternative|instead of|other than|similar to)\b/i },
  { category: "purchase", re: /\b(buy|purchase|order|price|cheap|affordable|where to buy|deal)\b/i },
];

/**
 * @param {string} question
 * @returns {"discovery"|"comparison"|"problem"|"alternative"|"purchase"|"category"}
 */
export function categorizeQuestion(question) {
  const q = String(question || "");
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(q)) return rule.category;
  }
  return "category";
}

/**
 * Upsert questions for a website. Duplicate text (same websiteId+question) reuses the row.
 * @param {import("@prisma/client").PrismaClient} db
 * @param {{ websiteId: string, questions: string[] }} opts
 * @returns {Promise<Array<{ id: string, question: string, category: string, sortOrder: number }>>}
 */
export async function upsertBuyerQuestions(db, { websiteId, questions }) {
  const list = [];
  const seen = new Set();
  let sortOrder = 0;

  for (const raw of questions || []) {
    const question = String(raw || "").trim().slice(0, 500);
    if (!question) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const category = categorizeQuestion(question);
    const row = await db.buyerQuestion.upsert({
      where: { websiteId_question: { websiteId, question } },
      create: { websiteId, question, category, active: true },
      update: { active: true, category },
    });
    list.push({ id: row.id, question: row.question, category: row.category, sortOrder });
    sortOrder += 1;
  }

  return list;
}
