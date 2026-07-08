import { describe, expect, it } from "vitest";
import {
  categorizeBrowserRemoved,
  categorizeServerKeys,
  categoryLabels
} from "@/metadata-categories";

describe("metadata categorization", () => {
  it("maps raw exiftool keys to friendly categories, GPS first", () => {
    const categories = categorizeServerKeys([
      "GPS:GPSLatitude",
      "XMP:CreatorTool",
      "EXIF:Artist",
      "IFD0:ModifyDate",
      "XMP:Parameters"
    ]);
    expect(categories[0]).toBe("gps");
    expect(categories).toContain("ai");
    expect(categories).toContain("author");
    expect(categories).toContain("dates");
    expect(categoryLabels(categories)[0]).toBe("GPS location");
  });

  it("never returns values, only category slugs", () => {
    const categories = categorizeServerKeys(["XMP:Title", "PDF:Producer"]);
    expect(categories.every((c) => typeof c === "string" && !c.includes(":"))).toBe(true);
  });

  it("categorizes browser removed tokens (EXIF/XMP/text/thumbnail)", () => {
    expect(categorizeBrowserRemoved(["EXIF"])).toContain("dates");
    expect(categorizeBrowserRemoved(["XMP"])).toContain("ai");
    expect(categorizeBrowserRemoved(["tEXt"])).toContain("ai");
    expect(categorizeBrowserRemoved(["JFIF thumbnail"])).toContain("thumbnail");
    expect(categorizeBrowserRemoved(["Comment"])).toContain("comments");
  });

  it("de-duplicates categories", () => {
    const categories = categorizeServerKeys(["GPS:GPSLatitude", "GPS:GPSLongitude", "Composite:GPSPosition"]);
    expect(categories.filter((c) => c === "gps")).toHaveLength(1);
  });
});
