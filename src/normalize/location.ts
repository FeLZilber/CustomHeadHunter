export interface Place {
  city: string | null;
  region: string;
  country: "IL";
}

export type RemoteScope = "israel" | "other_country" | "worldwide" | "unstated";

export interface NormalizedLocation {
  places: Place[];
  isRemote: boolean;
  remoteScope: RemoteScope | null;
  mentionsOtherCountry: boolean;
}

interface CityRule {
  city: string;
  region: string;
  aliases: string[];
}

const CENTRAL = "Central Israel";
const SHEPHELA = "Shephela";

const CITIES: CityRule[] = [
  { city: "Modi'in", region: SHEPHELA, aliases: ["modiin", "modi in", "modiin maccabim reut", "מודיעין", "מכבים רעות"] },
  { city: "Jerusalem", region: "Jerusalem", aliases: ["jerusalem", "ירושלים"] },
  { city: "Tel Aviv", region: CENTRAL, aliases: ["tel aviv", "tel aviv yafo", "tel aviv jaffa", "telaviv", "tlv", "תל אביב", "תל אביב יפו", "ת\"א"] },
  { city: "Herzliya", region: CENTRAL, aliases: ["herzliya", "herzelia", "herzlia", "הרצליה"] },
  { city: "Ra'anana", region: CENTRAL, aliases: ["raanana", "ra anana", "רעננה"] },
  { city: "Kfar Saba", region: CENTRAL, aliases: ["kfar saba", "kfar sava", "כפר סבא"] },
  { city: "Hod HaSharon", region: CENTRAL, aliases: ["hod hasharon", "הוד השרון"] },
  { city: "Netanya", region: CENTRAL, aliases: ["netanya", "נתניה"] },
  { city: "Petah Tikva", region: CENTRAL, aliases: ["petah tikva", "petach tikva", "petah tiqwa", "פתח תקווה", "פתח תקוה"] },
  { city: "Ramat Gan", region: CENTRAL, aliases: ["ramat gan", "רמת גן"] },
  { city: "Givatayim", region: CENTRAL, aliases: ["givatayim", "גבעתיים"] },
  { city: "Bnei Brak", region: CENTRAL, aliases: ["bnei brak", "בני ברק"] },
  { city: "Holon", region: CENTRAL, aliases: ["holon", "חולון"] },
  { city: "Rishon LeZion", region: SHEPHELA, aliases: ["rishon lezion", "rishon le zion", "ראשון לציון"] },
  { city: "Rehovot", region: SHEPHELA, aliases: ["rehovot", "רחובות"] },
  { city: "Ness Ziona", region: SHEPHELA, aliases: ["ness ziona", "nes ziona", "נס ציונה"] },
  { city: "Yavne", region: SHEPHELA, aliases: ["yavne", "yavneh", "יבנה"] },
  { city: "Lod", region: SHEPHELA, aliases: ["lod", "לוד"] },
  { city: "Ramla", region: SHEPHELA, aliases: ["ramla", "רמלה"] },
  { city: "Airport City", region: SHEPHELA, aliases: ["airport city", "איירפורט סיטי"] },
  { city: "Kiryat Gat", region: "South", aliases: ["kiryat gat", "qiryat gat", "קרית גת", "קריית גת"] },
  { city: "Ashdod", region: "South", aliases: ["ashdod", "אשדוד"] },
  { city: "Beer Sheva", region: "South", aliases: ["beer sheva", "beersheba", "be er sheva", "באר שבע"] },
  { city: "Haifa", region: "North", aliases: ["haifa", "חיפה"] },
  { city: "Yokneam", region: "North", aliases: ["yokneam", "yoqneam", "יקנעם"] },
  { city: "Caesarea", region: "North", aliases: ["caesarea", "קיסריה"] },
];

const REGIONS: Array<{ region: string; aliases: string[] }> = [
  { region: SHEPHELA, aliases: ["shephela", "shfela", "shefela", "שפלה", "השפלה"] },
  { region: CENTRAL, aliases: ["central israel", "center of israel", "gush dan", "מרכז", "גוש דן"] },
];

// "IL" is left out: on a location line it usually means Illinois. Lever's country code is mapped by its connector.
const ISRAEL_ALIASES = ["israel", "ישראל"];

const OTHER_COUNTRY = /\b(?:usa?|u\.s\.a?\.?|united states|canada|uk|united kingdom|germany|france|spain|poland|ireland|netherlands|romania|ukraine|portugal|italy|india|singapore|japan|australia|brazil|mexico|europe|emea|apac|latam|north america|new york|san francisco|london|berlin|paris|amsterdam)\b/;

const WORLDWIDE = /\b(?:worldwide|anywhere|global(?:ly)?)\b/;
const REMOTE = /\b(?:remote|work from home|wfh)\b|מרחוק|מהבית/;

/** Folds punctuation, geresh and case so aliases need only one spelling. */
export function foldText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[֑-ׇ]/g, "") // Hebrew points and cantillation.
    .replace(/['’`´׳]/g, "")
    .replace(/״/g, '"')
    .replace(/[-–—_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const HEBREW_PREFIX = "[בלהמו]?";

function aliasPattern(alias: string): RegExp {
  const folded = foldText(alias).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hebrew = /[֐-׿]/.test(alias);
  return new RegExp(`(?<![\\p{L}\\p{N}])${hebrew ? HEBREW_PREFIX : ""}${folded}(?![\\p{L}\\p{N}])`, "u");
}

const cityMatchers = CITIES.map((rule) => ({ rule, patterns: rule.aliases.map(aliasPattern) }));
const regionMatchers = REGIONS.map((rule) => ({ rule, patterns: rule.aliases.map(aliasPattern) }));
const israelMatchers = ISRAEL_ALIASES.map(aliasPattern);

export function normalizeLocation(values: Array<string | null | undefined>): NormalizedLocation {
  const text = foldText(values.filter(Boolean).join(" | "));
  const places = new Map<string, Place>();

  for (const { rule, patterns } of cityMatchers) {
    if (patterns.some((pattern) => pattern.test(text))) {
      places.set(rule.city, { city: rule.city, region: rule.region, country: "IL" });
    }
  }
  for (const { rule, patterns } of regionMatchers) {
    if (patterns.some((pattern) => pattern.test(text))) {
      const covered = [...places.values()].some((place) => place.region === rule.region);
      if (!covered) places.set(`region:${rule.region}`, { city: null, region: rule.region, country: "IL" });
    }
  }
  const mentionsIsrael = israelMatchers.some((pattern) => pattern.test(text));
  if (mentionsIsrael && places.size === 0) {
    places.set("country", { city: null, region: "Israel", country: "IL" });
  }

  const mentionsOtherCountry = OTHER_COUNTRY.test(text);
  const isRemote = REMOTE.test(text);
  let remoteScope: RemoteScope | null = null;
  if (isRemote) {
    if (mentionsIsrael || places.size > 0) remoteScope = "israel";
    else if (mentionsOtherCountry) remoteScope = "other_country";
    else if (WORLDWIDE.test(text)) remoteScope = "worldwide";
    else remoteScope = "unstated";
  }
  return { places: [...places.values()], isRemote, remoteScope, mentionsOtherCountry };
}

/** In scope with Israeli evidence, or remote without a stated foreign restriction. No location at all is out of scope. */
export function isInIsraelScope(location: NormalizedLocation): boolean {
  if (location.places.length > 0) return true;
  if (location.mentionsOtherCountry) return false;
  return location.isRemote ? location.remoteScope !== "other_country" : false;
}
