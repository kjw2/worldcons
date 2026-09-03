import {
  assertConstitutionAnnotatedDiscoveryEnabled,
} from "@/lib/backfill/us-constitution-annotated";
import {
  postgresUsConanAuthorityRepository,
  type UsConanAuthorityRepository,
} from "@/lib/backfill/us-conan-authority-repository";
import {
  resolveGovInfoUsReportsAuthority,
  type GovInfoAuthorityResolution,
  type GovInfoResolverDependencies,
} from "@/lib/crawlee/us-govinfo-reports-resolver";
import type { CrawlerExecutionHooks } from "@/lib/crawler/types";

export const GOVINFO_US_REPORTS_RESOLVER_VERSION = "govinfo-usreports-v1";

export interface ResolveUsConanCandidateAuthorityInput {
  candidateId: string;
  record: boolean;
}

export interface ResolveUsConanCandidateAuthorityDependencies {
  repository?: UsConanAuthorityRepository;
  resolver?: typeof resolveGovInfoUsReportsAuthority;
  resolverDependencies?: GovInfoResolverDependencies;
  environment?: Record<string, string | undefined>;
}

export interface ResolveUsConanCandidateAuthorityResult {
  candidateId: string;
  resolution: GovInfoAuthorityResolution;
  artifactId: string | null;
  reviewWritten: false;
  publicCatalogEnabled: false;
  geminiCalls: 0;
}

export async function resolveUsConanCandidateAuthority(
  input: ResolveUsConanCandidateAuthorityInput,
  hooks: CrawlerExecutionHooks = {},
  dependencies: ResolveUsConanCandidateAuthorityDependencies = {},
): Promise<ResolveUsConanCandidateAuthorityResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.candidateId)) {
    throw new Error("us_authority.invalid_candidate_id");
  }
  if (input.record) {
    assertConstitutionAnnotatedDiscoveryEnabled(dependencies.environment ?? process.env);
  }
  const repository = dependencies.repository ?? postgresUsConanAuthorityRepository;
  const candidate = await repository.getCandidate(input.candidateId);
  const resolution = await (dependencies.resolver ?? resolveGovInfoUsReportsAuthority)(
    candidate,
    hooks,
    dependencies.resolverDependencies,
  );
  const artifactId = input.record
    ? await repository.recordAuthority(candidate.id, GOVINFO_US_REPORTS_RESOLVER_VERSION, resolution)
    : null;
  return {
    candidateId: candidate.id,
    resolution,
    artifactId,
    reviewWritten: false,
    publicCatalogEnabled: false,
    geminiCalls: 0,
  };
}
