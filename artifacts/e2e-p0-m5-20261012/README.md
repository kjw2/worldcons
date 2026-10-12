# WorldCons M5 Production evidence — 2026-10-12

P0 completed: **false**. Implementation and final production release are recorded in [the report](../../docs/worldcons-e2e-p0-m5-production-release-20261012.md).

Authoritative latest records: final-deployment.json; m5-tag-final-release-result.json; corpus-after-tag-preservation-audit/corpus-audit.json; tag-final-verification-evidence.json; tag-final-external-public-probes.json; execution-limitations.json; original-worktree-preservation.json.

Historical failures, operator recovery, older deployment pins and intermediate bundles are retained as evidence and are not final release success. Read-only corpus audit uses the same algorithm with a SELECT-only D1 API adapter; see final-audit-algorithm-provenance.json. Current completion refers to three actual ES cases, not six cases; the extra three completion records are metadata refresh generations.

sha256-manifest.json seals all files in this directory except the manifest itself and records the report digest. Credential values are not included. Scripts are exact historical operator runs; do not blindly repeat a stale fenced plan. Client clock discrepancy is recorded in clock-provenance.json.
