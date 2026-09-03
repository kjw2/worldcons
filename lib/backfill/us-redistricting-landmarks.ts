export interface ReviewedUsRedistrictingLandmark {
  caseName: string;
  citation: string;
  officialAuthorityUrl: string;
  priority: 100;
  priorityOnly: true;
  constitutionalRelevanceStatus: "candidate";
  authorityEvidenceObservedAt: "2026-09-03";
}

// Initial high-precision scheduling set. Inclusion never bypasses Constitution Annotated
// essay-context, constitutional-holding, identity, or publication review gates.
export const REVIEWED_US_REDISTRICTING_LANDMARKS = [
  ["Baker v. Carr", "369 U.S. 186 (1962)"],
  ["Wesberry v. Sanders", "376 U.S. 1 (1964)"],
  ["Reynolds v. Sims", "377 U.S. 533 (1964)"],
  ["Shaw v. Reno", "509 U.S. 630 (1993)"],
  ["Vieth v. Jubelirer", "541 U.S. 267 (2004)"],
].map(([caseName, citation]) => {
  const match = citation.match(/^(\d+)\s+U\.S\.\s+(\d+)/);
  if (!match) throw new Error("invalid_reviewed_us_redistricting_landmark");
  return {
    caseName,
    citation,
    officialAuthorityUrl: `https://www.govinfo.gov/app/details/USREPORTS-${match[1]}/USREPORTS-${match[1]}-${match[2]}`,
    priority: 100,
    priorityOnly: true,
    constitutionalRelevanceStatus: "candidate",
    authorityEvidenceObservedAt: "2026-09-03",
  } satisfies ReviewedUsRedistrictingLandmark;
});

export const REVIEWED_US_REDISTRICTING_PRIORITY_CITATIONS = new Set(
  REVIEWED_US_REDISTRICTING_LANDMARKS.map((landmark) => landmark.citation),
);
