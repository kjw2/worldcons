import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  FRANCE_CONSEIL_APPROVED_POLICY_VERSION,
  FRANCE_CONSEIL_POLICY_VERSION_V1,
  FRANCE_CONSEIL_POLICY_VERSION_V2,
  FRANCE_CONSEIL_POLICY_VERSION_V3,
  FRANCE_CONSEIL_POLICY_VERSION_V4,
  FRANCE_CONSEIL_V2_E1_EXCEPTION,
  FRANCE_CONSEIL_V3_OMISSION_EXCEPTIONS,
  FRANCE_CONSEIL_V4_E3_CANONICALIZATION,
  FRANCE_CONSEIL_V4_E3_CANONICALIZATIONS,
  franceConseilAuthorityUrlCanonicalizationsFor,
  franceConseilOmissionExceptionsFor,
} from "../lib/backfill/france-scope";

function migration(name: string) {
  return fs.readFileSync(path.join(process.cwd(), "supabase/migrations", name), "utf8");
}

const policyV4Migration = migration("20260917120000_constitutional_case_france_policy_v4_approval.sql");

test("France v4 E3 canonicalization is one exact tuple and policy-version gated", () => {
  assert.equal(FRANCE_CONSEIL_APPROVED_POLICY_VERSION, FRANCE_CONSEIL_POLICY_VERSION_V4);
  assert.equal(FRANCE_CONSEIL_V4_E3_CANONICALIZATIONS.length, 1);
  assert.equal(FRANCE_CONSEIL_V4_E3_CANONICALIZATION.dilaId, "CONSTEXT000027147071");
  assert.equal(FRANCE_CONSEIL_V4_E3_CANONICALIZATION.dilaRecordId, "2012293_294_295_296QPC");
  assert.equal(FRANCE_CONSEIL_V4_E3_CANONICALIZATION.officialRecordId, "2012293_294_295_296qpc");
  assert.equal(
    FRANCE_CONSEIL_V4_E3_CANONICALIZATION.officialUrl,
    "https://www.conseil-constitutionnel.fr/decision/2013/2012293_294_295_296qpc.htm",
  );
  assert.deepEqual(
    franceConseilAuthorityUrlCanonicalizationsFor(2013, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V4),
    [FRANCE_CONSEIL_V4_E3_CANONICALIZATION],
  );
  // v1/v2/v3 never apply E3, and no other year/type/policy matches.
  assert.deepEqual(franceConseilAuthorityUrlCanonicalizationsFor(2013, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V3), []);
  assert.deepEqual(franceConseilAuthorityUrlCanonicalizationsFor(2013, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V2), []);
  assert.deepEqual(franceConseilAuthorityUrlCanonicalizationsFor(2013, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V1), []);
  assert.deepEqual(franceConseilAuthorityUrlCanonicalizationsFor(2013, "QPC", null), []);
  assert.deepEqual(franceConseilAuthorityUrlCanonicalizationsFor(2013, "DC", FRANCE_CONSEIL_POLICY_VERSION_V4), []);
  for (const year of [2010, 2011, 2012, 2014, 2017, 2024]) {
    assert.deepEqual(franceConseilAuthorityUrlCanonicalizationsFor(year, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V4), [], String(year));
  }
});

test("France v4 keeps the v2/v3 omission exceptions and does not widen them", () => {
  assert.deepEqual(
    franceConseilOmissionExceptionsFor(2022, "DC", FRANCE_CONSEIL_POLICY_VERSION_V4),
    [FRANCE_CONSEIL_V2_E1_EXCEPTION],
  );
  assert.deepEqual(
    franceConseilOmissionExceptionsFor(2017, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V4),
    FRANCE_CONSEIL_V3_OMISSION_EXCEPTIONS,
  );
  assert.deepEqual(franceConseilOmissionExceptionsFor(2017, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V3), FRANCE_CONSEIL_V3_OMISSION_EXCEPTIONS);
  assert.deepEqual(franceConseilOmissionExceptionsFor(2010, "QPC", FRANCE_CONSEIL_POLICY_VERSION_V4), []);
  assert.deepEqual(franceConseilOmissionExceptionsFor(2013, "DC", FRANCE_CONSEIL_POLICY_VERSION_V4), []);
});

test("France v4 migration is additive, supersedes v3, and authorizes only the exact E3 tuple", () => {
  assert.match(policyV4Migration, /france-dila-constit-2026-09-v4/);
  assert.match(policyV4Migration, /supersedes_policy_version[\s\S]*france-dila-constit-2026-09-v3/);
  assert.match(policyV4Migration, /FRANCE_CONSTIT_POLICY_V4_APPROVAL_CONFLICT/);
  assert.match(policyV4Migration, /create or replace function france_conseil_omission_exceptions_v1/);
  assert.match(policyV4Migration, /create or replace function france_conseil_authority_url_canonicalizations_v1/);
  assert.match(policyV4Migration, /CONSTEXT000027147071/);
  assert.match(policyV4Migration, /2012293_294_295_296QPC/);
  assert.match(policyV4Migration, /2012293_294_295_296qpc/);
  assert.match(policyV4Migration, /e3AuthorityUrlCanonicalization/);
});
