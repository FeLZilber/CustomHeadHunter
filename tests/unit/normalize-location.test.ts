import { describe, expect, it } from "vitest";
import { isInIsraelScope, normalizeLocation } from "../../src/normalize/location";

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
