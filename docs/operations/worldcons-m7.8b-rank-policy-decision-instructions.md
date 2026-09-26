# WorldCons M7.8-B rank-policy decision record — template and instructions

Date: 2026-09-26

## Status

This directory contains both the original **UNSIGNED / UNDECIDED** template and
the finalized product-owner decision:

- `docs/operations/worldcons-m7.8b-rank-policy-decision.template.json`
- `docs/operations/worldcons-m7.8b-rank-policy-decision.json`

It is deliberately `policy: "undecided"` with **no** `decidedAt`, **no**
`decidedByRole` and **no** `decisionHash`. It is not a decision. **No policy has
been chosen on the user's behalf**.

On 2026-09-26 the product owner explicitly selected
`candidate-coverage-equivalence` with E1-E4 and signed role `product-owner`.
The finalized record binds `decisionHash=82962c60e602e2fc` to
`holdoutManifestHash=1452c95c29fba160`. The first effective read-only v5
holdout passed all gating invariants (E1 8/8, E2 15/15, E3 18/18, E4 18/18),
with 1,258/1,258 exact production/local scope, zero errors and zero blockers.
Evidence is stored at
`artifacts/cloudflare-m7/m7.8b-fts-parity-holdout.{json,md}`.

The `fulltext_rank_threshold_unagreed` blocker is therefore retired. This does
not itself grant `GO-SEARCH`; deployed Worker bearer-path runtime evidence and
the final M7 gate remain pending.

## What this record governs

M7.8-B authors the **surfaces only**:

- an additive, content-free v5 **holdout** corpus
  (`lib/cloudflare/search-rank-policy/corpus.manifest.v5-holdout.json`,
  `holdout.ts`), disjoint from the active v4 corpus
  (`corpusHash ed18add749fe4a23`) by normalized `(category, query, filters)`;
- a typed, fail-closed **decision** record (`decision.ts`);
- a product-neutral **equivalence** evaluator (`equivalence.ts`);
- an additive read-only **holdout** mode of `scripts/d1-fts-parity.ts`
  (`--manifest=holdout-v5 --decision=<path>`).

The v4 manifest/hash and all v1/v2/v3 archives remain **byte-for-byte
unchanged**. The active v4 evidence/manifest is untouched.

## How to sign a decision (generic human/product procedure)

1. Copy the template to a working path:

   ```text
   cp docs/operations/worldcons-m7.8b-rank-policy-decision.template.json \
      docs/operations/worldcons-m7.8b-rank-policy-decision.json
   ```

2. Choose exactly **one** `policy` and fill the record:
   - `policy`: one of `candidate-coverage-equivalence`, `numeric-thresholds`,
     `informational-only` (never leave `undecided`);
   - `decisionId`: a stable identifier for this decision;
   - `decidedAt`: a real UTC ISO-8601 timestamp;
   - `decidedByRole`: the human/product signer role (for example
     `product-owner`);
   - `holdoutManifestHash`: the frozen v5 holdout hash
     `1452c95c29fba160` (do not edit it to match anything else);
   - `rationale`: the human rationale (required for `numeric-thresholds`);
   - `thresholds`: **only** for `numeric-thresholds`, with at least one explicit
     value; every other policy must keep `thresholds: null`.

3. Compute the canonical `decisionHash` over the record body (everything except
   `decisionHash`) using `rankDecisionHash` from
   `lib/cloudflare/search-rank-policy/decision.ts`, then paste it in. The
   validator recomputes and rejects a mismatch.

4. Run the read-only holdout (writes evidence only after a valid decision):

   ```text
   pnpm tsx scripts/d1-fts-parity.ts --manifest=holdout-v5 \
     --decision=docs/operations/worldcons-m7.8b-rank-policy-decision.json --report
   ```

   or the safe package script:

   ```text
   pnpm m7.8b:holdout -- --decision=docs/operations/worldcons-m7.8b-rank-policy-decision.json
   ```

The harness **refuses** (`decision_fail_closed`) unless the decision is
finalized, bound to the v5 holdout hash, hash-verified, free of any sealed v4
metric literal/reference field, and threshold-consistent with its policy. It
refuses an `undecided` record **before any linked query**.

## The three policies (described, not adopted)

The M7.8 plan recommends evaluating a **non-numeric** option first. The options
are described here exactly as the plan frames them; **this template adopts
none of them**.

### 1. `candidate-coverage-equivalence` (recommended non-numeric option)

Accept if and only if the four product-neutral invariants hold, evaluated by
`equivalence.ts`:

- **E1** — strict exact-case/exact-title invariants hold for **100%** of
  evaluable holdout cases;
- **E2** — whenever production returned a non-empty window, the production
  **top-1** id appears **anywhere** in the local first-page top `limit`;
- **E3** — every local returned id belongs to the same prevalidated
  scope/filter id set (no scope leak);
- **E4** — the local window is non-empty **iff** the production window is
  non-empty.

Exact-order, same-set and overlap metrics are **informational only** and never
gate this mode. This option is non-numeric: it has **no** `thresholds` and
requires **no** invented number. It is the plan's recommended first evaluation
because it is product-neutral and threshold-free.

### 2. `numeric-thresholds`

Accept if and only if the signed, explicit aggregate thresholds are met. This
mode **requires** at least one threshold value (for example
`minOverlapAtKMacro`) and a rationale. The threshold numbers are **not**
provided here and must come from outside any single observed result; a
threshold copied from the sealed v4 evidence is rejected by the sealed-v4
metric guard. This is the strictest and most brittle option.

### 3. `informational-only`

Sign that the decision is **knowingly informational**: the holdout is run as
evidence only, the state stays `insufficient_evidence`, and the
`fulltext_rank_threshold_unagreed` blocker **remains** so `GO-SEARCH` continues
to be blocked. This option intentionally does not unblock anything.

## Fail-closed guarantees

The parser/validator (`decision.ts`) rejects:

- `policy: "undecided"` (when a finalized decision is required) — before any
  linked query;
- a `holdoutManifestHash` that does not match the frozen v5 holdout hash;
- a `decisionHash` that does not verify;
- any raw record carrying a sealed v4 metric literal (for example
  `0.3083333333`, `0.5833333333`, `ed18add749fe4a23`) or a sealed reference
  field (for example `observedId`, `oracleTopId`, `expectedIds`, `metrics`);
- `numeric-thresholds` without explicit thresholds and a rationale;
- thresholds in any non-numeric policy.

## Boundaries and executed outcome

- The template remains `undecided`; it was copied into a distinct finalized
  decision record rather than edited in place.
- The signed policy is `candidate-coverage-equivalence`; no numeric threshold
  was inferred from sealed v4 outcomes.
- The read-only holdout evidence was created and passed with zero blockers.
- No Supabase/D1/Vectorize mutation, no deploy, no
  `SearchRepository`/`GO-SEARCH`/DNS/traffic switch, no commit/push.
- v1/v2/v3 archives and the active v4 manifest/evidence remain byte-for-byte
  unchanged.
- `fulltext_rank_threshold_unagreed` is retired by the signed decision plus
  passing disjoint holdout; deployed-runtime evidence remains a separate gate.
