# Recommended analytics events (not implemented)

Agenticaso currently has **no** product analytics SDK (no PostHog/GA/Mixpanel installed in Phase 7.1).

Do **not** add a heavy analytics stack solely for launch hardening. When you add analytics later, prefer one provider and emit:

| Event | When |
|-------|------|
| `landing_view` | Marketing home viewed |
| `free_audit_started` | User starts Free/v2 audit |
| `free_audit_completed` | Audit completes successfully |
| `signup_completed` | Clerk signup finished |
| `upgrade_viewed` | `/pricing` or upgrade CTA viewed |
| `checkout_started` | `POST /api/billing/checkout` succeeds |
| `checkout_completed` | Webhook activates Pro |
| `audit_limit_reached` | 402 entitlement / usage preflight |
| `monitoring_enabled` | Monitoring created/activated |
| `fix_generated` | Fix endpoint returns a fix |
| `reaudit_completed` | Re-audit finishes |

## Privacy rules

- Do not send raw AI answers, API keys, payment tokens, or full page HTML.
- Prefer workspace/plan enums and coarse counts over free-text PII.
- Update `/privacy` when analytics are enabled.
