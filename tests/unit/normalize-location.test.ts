import { describe, expect, it } from "vitest";
import { CITY_DISTANCES_KM, distanceFromHome, isInIsraelScope, normalizeLocation } from "../../src/normalize/location";

const cities = (value: string) => normalizeLocation([value]).places.map((place) => place.city);

describe("location normalization", () => {
  it.each([
    ["Modiin", "Modi'in"],
    ["Modi'in", "Modi'in"],
    ["Modi’in", "Modi'in"],
    ["מודיעין", "Modi'in"],
    ["במודיעין", "Modi'in"],
    ["Tel-Aviv", "Tel Aviv"],
    ["תל אביב", "Tel Aviv"],
    ['ת"א', "Tel Aviv"],
    ["ירושלים", "Jerusalem"],
    ["Be'er Sheva", "Beer Sheva"],
    ["פתח תקווה", "Petah Tikva"],
  ])("recognizes %s", (value, city) => {
    expect(cities(value)).toContain(city);
  });

  it("keeps every place of a multi-location job", () => {
    expect(cities("Tel Aviv, Israel | Haifa, Israel | London, UK")).toEqual(["Tel Aviv", "Haifa"]);
  });

  it("maps a city to its region", () => {
    expect(normalizeLocation(["Rehovot"]).places[0]?.region).toBe("Shephela");
    expect(normalizeLocation(["Herzliya"]).places[0]?.region).toBe("Central Israel");
  });

  it("records a country-only location without inventing a city", () => {
    expect(normalizeLocation(["Israel"]).places).toEqual([{ city: null, region: "Israel", country: "IL" }]);
  });

  it("does not read Illinois as Israel", () => {
    const location = normalizeLocation(["Chicago, IL"]);
    expect(location.places).toEqual([]);
    expect(isInIsraelScope(location)).toBe(false);
  });

  it("does not match a city inside another word", () => {
    expect(cities("Lodz, Poland")).toEqual([]);
    expect(cities("Holonic Systems")).toEqual([]);
  });

  it("distinguishes remote scopes", () => {
    expect(normalizeLocation(["Remote - Israel"]).remoteScope).toBe("israel");
    expect(normalizeLocation(["עבודה מהבית, ישראל"]).remoteScope).toBe("israel");
    expect(normalizeLocation(["Remote - Europe only"]).remoteScope).toBe("other_country");
    expect(normalizeLocation(["Remote, US"]).remoteScope).toBe("other_country");
    expect(normalizeLocation(["Remote - Worldwide"]).remoteScope).toBe("worldwide");
    expect(normalizeLocation(["Remote"]).remoteScope).toBe("unstated");
    expect(normalizeLocation(["Tel Aviv"]).remoteScope).toBeNull();
  });

  it("scopes listings to Israel", () => {
    const inScope = (value: string) => isInIsraelScope(normalizeLocation([value]));
    expect(inScope("Tel Aviv | New York")).toBe(true);
    expect(inScope("Remote - Israel")).toBe(true);
    expect(inScope("Remote")).toBe(true);
    expect(inScope("Remote - Worldwide")).toBe(true);
    expect(inScope("Remote, Germany")).toBe(false);
    expect(inScope("New York, NY")).toBe(false);
    expect(inScope("")).toBe(false);
  });
});

describe("distance from home", () => {
  const km = (value: string) => distanceFromHome(normalizeLocation([value]).places);

  it("knows a plausible distance for every city", () => {
    for (const [city, distance] of CITY_DISTANCES_KM) {
      expect(distance, city).toBeGreaterThanOrEqual(0);
      expect(distance, city).toBeLessThan(300); // Eilat is the farthest.
    }
  });

  it("measures straight-line km from Modi'in-Maccabim-Re'ut", () => {
    expect(km("Modiin Maccabim Reut")).toBe(0);
    expect(km("Tel Aviv, Israel")).toBeGreaterThanOrEqual(27);
    expect(km("Tel Aviv, Israel")).toBeLessThanOrEqual(33);
    expect(km("Haifa")).toBeGreaterThanOrEqual(95);
    expect(km("Haifa")).toBeLessThanOrEqual(105);
  });

  it("recognizes towns outside the big cities, in English and Hebrew", () => {
    expect(cities("Rosh Ha'Ayin, Israel")).toEqual(["Rosh HaAyin"]);
    expect(cities("Yehud-Monosson")).toEqual(["Yehud"]);
    expect(cities("Or Yehuda, Center District")).toEqual(["Or Yehuda"]);
    expect(cities("בית שמש")).toEqual(["Beit Shemesh"]);
    expect(cities("Be'er Ya'akov")).toEqual(["Be'er Ya'akov"]);
    expect(cities("Beer Sheva")).toEqual(["Beer Sheva"]);
    expect(km("Shoham")).toBeLessThan(20);
    expect(km("Kiryat Shmona")).toBeGreaterThan(140);
  });

  it("takes the nearest of several cities", () => {
    expect(km("Haifa | Lod")).toBe(km("Lod"));
  });

  it("gives no distance without a known city", () => {
    expect(km("Central Israel")).toBeNull();
    expect(km("Remote - Israel")).toBeNull();
    expect(km("")).toBeNull();
  });
});
