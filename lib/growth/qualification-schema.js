/**
 * Optional provider response_format for Growth reasoner only.
 * Local validator remains the trust boundary (pack IDs, no invented evidence).
 */

import { QUALIFICATION_DECISIONS, REASON_TYPES } from "./qualification-contract.js";

const reasonItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "statement", "evidenceIds"],
  properties: {
    type: { type: "string", enum: [...REASON_TYPES] },
    statement: { type: "string" },
    evidenceIds: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
    },
  },
};

const uncertaintyItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "statement", "evidenceIds"],
  properties: {
    type: { type: "string", enum: [...REASON_TYPES] },
    statement: { type: "string" },
    evidenceIds: {
      type: "array",
      items: { type: "string" },
    },
  },
};

export const QUALIFICATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "summary", "reasons", "uncertainties"],
  properties: {
    decision: { type: "string", enum: [...QUALIFICATION_DECISIONS] },
    summary: { type: "string" },
    reasons: { type: "array", items: reasonItemSchema },
    uncertainties: { type: "array", items: uncertaintyItemSchema },
  },
};

export const QUALIFICATION_JSON_SCHEMA_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "qualification_result",
    strict: true,
    schema: QUALIFICATION_JSON_SCHEMA,
  },
};

export const QUALIFICATION_JSON_OBJECT_FORMAT = {
  type: "json_object",
};
