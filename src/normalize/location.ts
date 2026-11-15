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
  /** City centre, for the distance shown next to a job. Not used for matching. */
  lat: number;
  lon: number;
}

const CENTRAL = "Central Israel";
const SHEPHELA = "Shephela";

const CITIES: CityRule[] = [
  { city: "Modi'in", region: SHEPHELA, lat: 31.8969, lon: 35.0104, aliases: ["modiin", "modi in", "modiin maccabim reut", "מודיעין", "מכבים רעות"] },
  { city: "Jerusalem", region: "Jerusalem", lat: 31.7683, lon: 35.2137, aliases: ["jerusalem", "ירושלים"] },
  { city: "Tel Aviv", region: CENTRAL, lat: 32.0853, lon: 34.7818, aliases: ["tel aviv", "tel aviv yafo", "tel aviv jaffa", "telaviv", "tlv", "תל אביב", "תל אביב יפו", "ת\"א"] },
  { city: "Herzliya", region: CENTRAL, lat: 32.1663, lon: 34.8436, aliases: ["herzliya", "herzelia", "herzlia", "הרצליה"] },
  { city: "Ra'anana", region: CENTRAL, lat: 32.1848, lon: 34.8713, aliases: ["raanana", "ra anana", "רעננה"] },
  { city: "Kfar Saba", region: CENTRAL, lat: 32.1782, lon: 34.9076, aliases: ["kfar saba", "kfar sava", "כפר סבא"] },
  { city: "Hod HaSharon", region: CENTRAL, lat: 32.1593, lon: 34.8932, aliases: ["hod hasharon", "הוד השרון"] },
  { city: "Netanya", region: CENTRAL, lat: 32.3215, lon: 34.8532, aliases: ["netanya", "נתניה"] },
  { city: "Petah Tikva", region: CENTRAL, lat: 32.084, lon: 34.8878, aliases: ["petah tikva", "petach tikva", "petah tiqwa", "פתח תקווה", "פתח תקוה"] },
  { city: "Ramat Gan", region: CENTRAL, lat: 32.0684, lon: 34.8248, aliases: ["ramat gan", "רמת גן"] },
  { city: "Givatayim", region: CENTRAL, lat: 32.0722, lon: 34.8125, aliases: ["givatayim", "גבעתיים"] },
  { city: "Bnei Brak", region: CENTRAL, lat: 32.0807, lon: 34.8338, aliases: ["bnei brak", "בני ברק"] },
  { city: "Holon", region: CENTRAL, lat: 32.0158, lon: 34.7874, aliases: ["holon", "חולון"] },
  { city: "Rishon LeZion", region: SHEPHELA, lat: 31.973, lon: 34.7925, aliases: ["rishon lezion", "rishon le zion", "ראשון לציון"] },
  { city: "Rehovot", region: SHEPHELA, lat: 31.8928, lon: 34.8113, aliases: ["rehovot", "רחובות"] },
  { city: "Ness Ziona", region: SHEPHELA, lat: 31.9293, lon: 34.7987, aliases: ["ness ziona", "nes ziona", "נס ציונה"] },
  { city: "Yavne", region: SHEPHELA, lat: 31.8781, lon: 34.7392, aliases: ["yavne", "yavneh", "יבנה"] },
  { city: "Lod", region: SHEPHELA, lat: 31.9516, lon: 34.8953, aliases: ["lod", "לוד"] },
  { city: "Ramla", region: SHEPHELA, lat: 31.9279, lon: 34.8625, aliases: ["ramla", "רמלה"] },
  { city: "Airport City", region: SHEPHELA, lat: 31.9822, lon: 34.88, aliases: ["airport city", "איירפורט סיטי"] },
  { city: "Kiryat Gat", region: "South", lat: 31.61, lon: 34.7642, aliases: ["kiryat gat", "qiryat gat", "קרית גת", "קריית גת"] },
  { city: "Ashdod", region: "South", lat: 31.8044, lon: 34.6553, aliases: ["ashdod", "אשדוד"] },
  { city: "Beer Sheva", region: "South", lat: 31.2518, lon: 34.7913, aliases: ["beer sheva", "beersheba", "be er sheva", "באר שבע"] },
  { city: "Haifa", region: "North", lat: 32.794, lon: 34.9896, aliases: ["haifa", "חיפה"] },
  { city: "Yokneam", region: "North", lat: 32.6593, lon: 35.11, aliases: ["yokneam", "yoqneam", "יקנעם"] },
  { city: "Caesarea", region: "North", lat: 32.4936, lon: 34.9089, aliases: ["caesarea", "קיסריה"] },
  { city: "Rosh HaAyin", region: CENTRAL, lat: 32.0956, lon: 34.9566, aliases: ["rosh haayin", "rosh ha ayin", "rosh haain", "ראש העין"] },
  { city: "Or Yehuda", region: CENTRAL, lat: 32.0306, lon: 34.8556, aliases: ["or yehuda", "אור יהודה"] },
  { city: "Yehud", region: CENTRAL, lat: 32.0333, lon: 34.8833, aliases: ["yehud", "yehud monosson", "יהוד"] },
  { city: "Kiryat Ono", region: CENTRAL, lat: 32.0636, lon: 34.8553, aliases: ["kiryat ono", "qiryat ono", "קרית אונו", "קריית אונו"] },
  { city: "Givat Shmuel", region: CENTRAL, lat: 32.0778, lon: 34.8481, aliases: ["givat shmuel", "גבעת שמואל"] },
  { city: "Ramat HaSharon", region: CENTRAL, lat: 32.1461, lon: 34.8394, aliases: ["ramat hasharon", "ramat ha sharon", "רמת השרון"] },
  { city: "Bat Yam", region: CENTRAL, lat: 32.0171, lon: 34.7454, aliases: ["bat yam", "בת ים"] },
  { city: "Even Yehuda", region: CENTRAL, lat: 32.27, lon: 34.8875, aliases: ["even yehuda", "אבן יהודה"] },
  { city: "Shoham", region: SHEPHELA, lat: 31.9987, lon: 34.9461, aliases: ["shoham", "שוהם"] },
  { city: "Be'er Ya'akov", region: SHEPHELA, lat: 31.942, lon: 34.834, aliases: ["beer yaakov", "beer yaacov", "באר יעקב"] },
  { city: "Gedera", region: SHEPHELA, lat: 31.8124, lon: 34.7797, aliases: ["gedera", "גדרה"] },
  { city: "Beit Shemesh", region: "Jerusalem", lat: 31.747, lon: 34.9881, aliases: ["beit shemesh", "bet shemesh", "בית שמש"] },
  { city: "Mevaseret Zion", region: "Jerusalem", lat: 31.8016, lon: 35.1505, aliases: ["mevaseret zion", "mevaseret tsiyon", "מבשרת ציון"] },
  { city: "Ma'ale Adumim", region: "Jerusalem", lat: 31.777, lon: 35.298, aliases: ["maale adumim", "maale adummim", "מעלה אדומים"] },
  { city: "Ashkelon", region: "South", lat: 31.6688, lon: 34.5743, aliases: ["ashkelon", "אשקלון"] },
  { city: "Omer", region: "South", lat: 31.265, lon: 34.85, aliases: ["omer", "עומר"] },
  { city: "Dimona", region: "South", lat: 31.07, lon: 35.0333, aliases: ["dimona", "דימונה"] },
  { city: "Eilat", region: "South", lat: 29.5577, lon: 34.9519, aliases: ["eilat", "אילת"] },
  { city: "Hadera", region: "North", lat: 32.434, lon: 34.9196, aliases: ["hadera", "חדרה"] },
  { city: "Or Akiva", region: "North", lat: 32.505, lon: 34.918, aliases: ["or akiva", "אור עקיבא"] },
  { city: "Zichron Yaakov", region: "North", lat: 32.57, lon: 34.952, aliases: ["zichron yaakov", "zikhron yaakov", "זכרון יעקב"] },
  { city: "Tirat Carmel", region: "North", lat: 32.76, lon: 34.9717, aliases: ["tirat carmel", "tirat hacarmel", "טירת כרמל"] },
  { city: "Migdal HaEmek", region: "North", lat: 32.675, lon: 35.24, aliases: ["migdal haemek", "migdal ha emek", "מגדל העמק"] },
  { city: "Afula", region: "North", lat: 32.6075, lon: 35.2892, aliases: ["afula", "עפולה"] },
  { city: "Nazareth", region: "North", lat: 32.6996, lon: 35.3035, aliases: ["nazareth", "נצרת"] },
  { city: "Nof HaGalil", region: "North", lat: 32.707, lon: 35.327, aliases: ["nof hagalil", "nazareth illit", "upper nazareth", "נוף הגליל"] },
  { city: "Karmiel", region: "North", lat: 32.919, lon: 35.2901, aliases: ["karmiel", "carmiel", "כרמיאל"] },
  { city: "Tiberias", region: "North", lat: 32.7922, lon: 35.5312, aliases: ["tiberias", "טבריה"] },
  { city: "Rosh Pina", region: "North", lat: 32.969, lon: 35.542, aliases: ["rosh pina", "rosh pinna", "ראש פינה"] },
  { city: "Kiryat Shmona", region: "North", lat: 33.2073, lon: 35.57, aliases: ["kiryat shmona", "qiryat shemona", "קרית שמונה", "קריית שמונה"] },
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

/** Where the owner lives. Distances on the dashboard and in alerts are measured from here. */
export const HOME = { name: "Modi'in-Maccabim-Re'ut", lat: 31.8969, lon: 35.0104 } as const;

const EARTH_RADIUS_KM = 6371;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance, rounded to whole km. */
function kmFromHome(lat: number, lon: number): number {
  const dLat = radians(lat - HOME.lat);
  const dLon = radians(lon - HOME.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(HOME.lat)) * Math.cos(radians(lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a)));
}

/** Straight-line km from home to each known city. The dashboard query sorts and filters on the same numbers. */
export const CITY_DISTANCES_KM: ReadonlyArray<readonly [city: string, km: number]> = CITIES.map((rule) => [rule.city, kmFromHome(rule.lat, rule.lon)] as const);

const distanceByCity = new Map(CITY_DISTANCES_KM);

/** The nearest of a job's cities, or null when no place names a known city (region only, remote, unstated). */
export function distanceFromHome(places: Array<Pick<Place, "city">>): number | null {
  const distances = places.flatMap((place) => {
    const km = place.city ? distanceByCity.get(place.city) : undefined;
    return km === undefined ? [] : [km];
  });
  return distances.length ? Math.min(...distances) : null;
}
