/**
 * LAYER 2 orchestrator.
 * Site Profile + project goal → envelope → program → site plan → flags.
 */
import { SITE_PROFILE_VERSION, type SiteProfile } from "./types";
import {
  FEASIBILITY_VERSION,
  type ProjectType,
  type ProjectParams,
  type FeasibilityResult,
} from "./feasibilityTypes";
import { computeEnvelope, computeProgram } from "./program";
import { generateSitePlan } from "./siteplan";

export function runFeasibility(
  profile: SiteProfile,
  type: ProjectType,
  params: ProjectParams = {}
): FeasibilityResult {
  const envelope = computeEnvelope(profile, type, params);
  const program = computeProgram(type, envelope, profile, params);
  const sitePlan = generateSitePlan(profile, program, envelope);
  const flags = buildFlags(profile, type, envelope);

  return {
    version: FEASIBILITY_VERSION,
    parcelId: profile.parcelId,
    siteProfileVersion: SITE_PROFILE_VERSION,
    projectType: type,
    createdAt: new Date().toISOString(),
    envelope,
    program,
    sitePlan,
    flags,
    costEstimate: null, // next chapter
  };
}

/** Surface hard constraints a reviewer must see. */
function buildFlags(
  profile: SiteProfile,
  type: ProjectType,
  env: FeasibilityResult["envelope"]
): FeasibilityResult["flags"] {
  const flags: FeasibilityResult["flags"] = [];

  // Permitted-use check against zoning.
  const uses = (profile.parcel.permittedUses.value || []).map((u) => u.toLowerCase());
  const useKeywords: Record<ProjectType, string[]> = {
    retreat: ["retreat", "lodging", "agritourism", "recreation"],
    hotel: ["hotel", "lodging", "commercial"],
    multifamily: ["multifamily", "residential", "apartment"],
    single_family: ["single-family", "single family", "residential"],
    retail: ["retail", "commercial"],
    mixed_use: ["mixed", "commercial", "residential"],
  };
  if (uses.length > 0) {
    const ok = useKeywords[type].some((k) => uses.some((u) => u.includes(k)));
    if (!ok)
      flags.push({
        level: "warn",
        message: `Zoning (${profile.parcel.zoningCode.value ?? "n/a"}) does not list this use among permitted uses — likely a rezone or variance.`,
      });
  }

  if (profile.parcel.zoningCode.source === "mock")
    flags.push({ level: "info", message: "Zoning is mock data — confirm with a real Regrid lookup before relying on the envelope." });

  if (env.buildableGsf <= 0)
    flags.push({ level: "blocker", message: "Constraints leave no buildable area at this program." });

  const floodZone = profile.enrichment.flood?.zone?.value;
  if (floodZone === "VE" || floodZone === "AE" || floodZone === "A")
    flags.push({ level: "warn", message: `Parcel intersects FEMA flood zone ${floodZone}; developable area reduced accordingly.` });

  if (profile.enrichment.wetlands?.overlaps?.value)
    flags.push({ level: "warn", message: "Wetlands present — Section 404 permitting likely; buffer deducted." });

  return flags;
}
