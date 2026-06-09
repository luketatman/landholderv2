/**
 * LAYER 3 Phase 4 — verified resource links for the build guide.
 *
 * The AI never emits a URL (it would hallucinate dead links). Instead it tags
 * each permit with a `linkKey`, and this module maps that to a URL we trust:
 * official federal/state landing pages, or a Google search scoped to the user's
 * county/state (a search link is never a 404). Keeps the report's links honest.
 */
export type LinkKey = "fema_flood" | "state_code" | "county_permit" | "septic" | "none";

export type ResolvedLink = { label: string; url: string };

export type LinkContext = {
  countyName: string | null; // e.g. "Dallas County, Texas"
  stateFips: string | null; // 2-digit
};

const STATE_BY_FIPS: Record<string, string> = {
  "01": "Alabama", "02": "Alaska", "04": "Arizona", "05": "Arkansas", "06": "California",
  "08": "Colorado", "09": "Connecticut", "10": "Delaware", "11": "District of Columbia",
  "12": "Florida", "13": "Georgia", "15": "Hawaii", "16": "Idaho", "17": "Illinois",
  "18": "Indiana", "19": "Iowa", "20": "Kansas", "21": "Kentucky", "22": "Louisiana",
  "23": "Maine", "24": "Maryland", "25": "Massachusetts", "26": "Michigan", "27": "Minnesota",
  "28": "Mississippi", "29": "Missouri", "30": "Montana", "31": "Nebraska", "32": "Nevada",
  "33": "New Hampshire", "34": "New Jersey", "35": "New Mexico", "36": "New York",
  "37": "North Carolina", "38": "North Dakota", "39": "Ohio", "40": "Oklahoma", "41": "Oregon",
  "42": "Pennsylvania", "44": "Rhode Island", "45": "South Carolina", "46": "South Dakota",
  "47": "Tennessee", "48": "Texas", "49": "Utah", "50": "Vermont", "51": "Virginia",
  "53": "Washington", "54": "West Virginia", "55": "Wisconsin", "56": "Wyoming",
};

export function stateName(stateFips: string | null): string | null {
  return stateFips ? STATE_BY_FIPS[stateFips] ?? null : null;
}

function search(q: string): string {
  return "https://www.google.com/search?q=" + encodeURIComponent(q);
}

/** Map a linkKey + context → a trustworthy link, or null for "none". */
export function resolveLink(key: LinkKey, ctx: LinkContext): ResolvedLink | null {
  const county = ctx.countyName?.split(",")[0]?.trim() || null; // "Dallas County"
  const st = stateName(ctx.stateFips);
  switch (key) {
    case "fema_flood":
      return { label: "FEMA Flood Map Service Center", url: "https://msc.fema.gov/portal/home" };
    case "state_code":
      return {
        label: st ? `${st} building code` : "State building code",
        url: search(`${st ?? ""} state building code official`),
      };
    case "county_permit":
      return {
        label: county ? `${county} permit office` : "County permit office",
        url: search(`${county ?? ""} ${st ?? ""} building permit department`),
      };
    case "septic":
      return {
        label: county ? `${county} septic / well permits` : "County health department",
        url: search(`${county ?? ""} ${st ?? ""} health department septic permit`),
      };
    default:
      return null;
  }
}

/** The always-shown "key resources" box for the report. */
export function keyResources(ctx: LinkContext): ResolvedLink[] {
  return ([
    resolveLink("county_permit", ctx),
    resolveLink("state_code", ctx),
    resolveLink("fema_flood", ctx),
    resolveLink("septic", ctx),
  ].filter(Boolean) as ResolvedLink[]);
}
