# M5 verification evidence — 2026-10-12

Verdict: M5 FAIL; P0 OPEN. See [the report](../../docs/worldcons-e2e-p0-m5-verification-20261012.md).

Authoritative results: verdict.json; guard-regressions-result.json and log (131 pass); schema-verification.json (54 present/SQL checks pass); corpus-audit-refreshed/corpus-audit.json (5 content mismatches); api-identity-body-diagnosis.json (5 exact originalUrl contract failures with matching approved body/summary); source-age-race-with-policy.json (two failing isolated SQL reproductions, production writes 0); writer-inventory.json; core/search/ingest-ledger.json; observation-window.json.

The first corpus-audit folder is an authentication failure, not a successful corpus check. Missing separate Ops config inspection errors are corrected in ops-deployment-inspection-correction.json; Ops runs in Root. Original evidence directories remain unchanged.

Production operations here are SELECT queries and public GETs only. Test fixtures use isolated local D1/workerd/SQLite and an in-memory R2 stub. No production recovery or deployment was performed. Normal production schedules continued; the snapshots have their own times.

All evidence bytes and the report are sealed in sha256-manifest.json.
