# Phase 7 — Monetization, Billing & Usage Entitlements

## Paid entitlement source of truth

Pro is granted **only** from a verified payment-provider subscription:

| Situation | Result |
|-----------|--------|
| Subscription `status=active` **and** `providerSubscriptionId` present | Pro (or Agency) |
| Subscription `cancelled` with `currentPeriodEnd` still in the future **and** provider id | Keep Pro until the already-paid period ends |
| `trialing` / checkout placeholder / `created` | **Free** — unpaid |
| `past_due` / `expired` / cancelled past period end | **Free** (historical rows retained) |
| No subscription row | **Free** |
| Clerk `publicMetadata.paid === true` (login / email verification) | **Ignored — Free** |
| Browser sends `paid` / plan / amount | **Ignored** |

Email verification and login must never activate Pro.

## Architecture

- Central plan config: `lib/billing/` (`plans`, `entitlements`, `usage`, `gates`, `subscription`)
- Payment adapters (historical Razorpay webhook processor included) write subscription rows; entitlements do not hard-code a processor name
- Checkout does **not** insert `trialing` rows or grant Pro
- DB: `Subscription`, `UsagePeriod`, `BillingWebhookEvent` (historical records kept)
- APIs: `POST /api/billing/checkout`, `POST /api/billing/webhook`, `GET|POST /api/billing/status`
- Pages: `/billing`, `/pricing`, dashboard usage card

## Canonical Pro price

`$19/month` (`DEFAULT_PRO_PRICE_LABEL` / `BILLING_PRO_MONTHLY_CENTS=1900`). UI must import the helper — do not hard-code ₹1,499.

## Env (server only)

```
BILLING_PRO_CURRENCY=USD
BILLING_PRO_MONTHLY_CENTS=1900
BILLING_PRO_MONTHLY_DISPLAY=19
```

Historical Razorpay webhook env vars may remain for existing event processing; they are not shown in the billing UI and do not grant Pro by themselves.

Never prefix billing secrets with `NEXT_PUBLIC_`.

## Security rules

- Client cannot set plan, price, or subscription status.
- Clerk email / `paid` metadata cannot grant Pro.
- Expensive actions preflight usage **before** provider calls.
- Failed provider calls are not billable AI tests.

## Downgrade

Expired/cancelled past period end → Free entitlements. Audits, websites, and history are retained; new usage is limited.
