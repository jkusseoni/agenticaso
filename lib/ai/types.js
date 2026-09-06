/**
 * Shared AI provider types for AgenticASO Multi-AI Audit Engine.
 * Project is JS; JSDoc documents the contracts.
 *
 * @typedef {"openai" | "perplexity" | "gemini"} ProviderId
 *
 * @typedef {Object} BuyerQueryInput
 * @property {string} brandName
 * @property {string} websiteUrl
 * @property {string} buyerQuestion
 * @property {string} [domain]
 * @property {string} [category]
 *
 * @typedef {Object} CompetitorMention
 * @property {string} name
 * @property {number|null} position
 * @property {boolean} mentioned
 *
 * @typedef {Object} AIProviderResult
 * @property {ProviderId} provider
 * @property {string} model
 * @property {string} question
 * @property {string} answer
 * @property {boolean} brandMentioned
 * @property {number|null} brandPosition
 * @property {boolean} recommended
 * @property {CompetitorMention[]} competitors
 * @property {string[]} citations
 * @property {number|null} confidence
 * @property {number} latencyMs
 * @property {string|null} error
 *
 * @typedef {Object} AIProvider
 * @property {ProviderId} id
 * @property {string} name
 * @property {(input: BuyerQueryInput) => Promise<AIProviderResult>} runBuyerQuery
 */

export {};
