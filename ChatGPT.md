
## 2026-11-09 — P0 Scanner Site Classification Fix

Status: Local automated verification PASS; deployment pending.

- Branch: fix/p0-scanner-site-classification
- Base commit: ebffc05
- Scanner tests: 31 passed, 0 failed.
- Changed classification from SaaS vs commerce_or_unknown to SaaS, ecommerce, or unknown.
- Unknown websites no longer receive unsupported Product, Offer, or Rating remediation issues.
- Shopify and reachable product-page evidence retain ecommerce classification.
- Off-origin product-page redirects are not accepted as product evidence.
- Updated regression tests for unknown, Shopify, and WooCommerce-like product pages.
- Existing scan report response shape retained.
- Syntax and git diff checks passed.
- Remaining: review classification edge cases, commit, deploy to protected Preview, and run live regression tests.
- No production deployment or database migration performed.
