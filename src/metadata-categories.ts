// Maps raw metadata field names to friendly, human-readable categories so the
// UI can show WHAT was removed without ever exposing the values themselves.
// Pure and dependency-free — used on both the server and the client.

export type MetadataCategory =
  | "gps"
  | "ai"
  | "author"
  | "software"
  | "dates"
  | "comments"
  | "thumbnail"
  | "document"
  | "svg"
  | "metadata";

export const CATEGORY_LABELS: Record<MetadataCategory, string> = {
  gps: "GPS location",
  ai: "AI prompt & generation data",
  author: "Author & copyright",
  software: "Software & device",
  dates: "Timestamps",
  comments: "Comments & description",
  thumbnail: "Embedded thumbnail",
  document: "Document properties",
  svg: "Scripts & unsafe SVG content",
  metadata: "Hidden metadata"
};

// Ordered so the most privacy-relevant categories surface first.
const CATEGORY_ORDER: MetadataCategory[] = [
  "gps",
  "ai",
  "author",
  "comments",
  "software",
  "dates",
  "thumbnail",
  "document",
  "svg",
  "metadata"
];

function sortCategories(set: Set<MetadataCategory>): MetadataCategory[] {
  return CATEGORY_ORDER.filter((category) => set.has(category));
}

const AI_PATTERN =
  /prompt|parameters|workflow|seed|sampler|scheduler|negativeprompt|comfy|automatic1111|stablediffusion|midjourney|dall|firefly|leonardo|ideogram|gemini|generat|\bmodel\b/i;
const AUTHOR_PATTERN = /artist|author|creator|copyright|byline|credit|\brights\b|owner|lastmodifiedby|producer/i;
const SOFTWARE_PATTERN = /software|\bmake\b|\bmodel\b|encoder|encoded|application|handlerdescription|writingapp|muxingapp|vendor|toolkit/i;
const DATE_PATTERN = /createdate|modifydate|datetime|creationdate|modificationdate|\bdate\b|\btime\b/i;
const COMMENT_PATTERN = /comment|description|\btitle\b|subject|keywords|usercomment|caption|headline|instructions|abstract/i;
const THUMB_PATTERN = /thumbnail|preview|jfxx/i;
const DOC_PATTERN = /company|manager|template|revision|totaledittime|docprops|lastprinted|category|contentstatus/i;

// Server side: raw exiftool `-G1` keys (e.g. "GPS:GPSLatitude", "XMP:CreatorTool").
export function categorizeServerKeys(keys: string[]): MetadataCategory[] {
  const found = new Set<MetadataCategory>();
  for (const key of keys) {
    const tag = key.split(":").pop() ?? key;
    if (/gps/i.test(key)) found.add("gps");
    else if (AI_PATTERN.test(key)) found.add("ai");
    else if (AUTHOR_PATTERN.test(tag)) found.add("author");
    else if (COMMENT_PATTERN.test(tag)) found.add("comments");
    else if (DATE_PATTERN.test(tag)) found.add("dates");
    else if (THUMB_PATTERN.test(tag)) found.add("thumbnail");
    else if (DOC_PATTERN.test(tag)) found.add("document");
    else if (SOFTWARE_PATTERN.test(tag)) found.add("software");
    else found.add("metadata");
  }
  return sortCategories(found);
}

// Client side: the browser image cleaner's `removed[]` tokens (EXIF, XMP,
// tEXt, JFIF thumbnail, APPn, ...). EXIF/XMP blocks are removed wholesale, so
// they map to broad categories.
export function categorizeBrowserRemoved(removed: string[]): MetadataCategory[] {
  const found = new Set<MetadataCategory>();
  for (const token of removed) {
    const t = token.toLowerCase();
    if (t === "gps") {
      found.add("gps");
    } else if (t === "author") {
      found.add("author");
    } else if (t === "software") {
      found.add("software");
    } else if (t === "datetime") {
      found.add("dates");
    } else if (t === "exif" || t === "exif\0\0" || t.includes("exif")) {
      // The whole EXIF block (camera, often GPS, timestamps) was stripped.
      found.add("metadata");
      found.add("dates");
    } else if (t === "xmp") {
      found.add("ai");
      found.add("author");
    } else if (t.startsWith("comment")) {
      found.add("comments");
    } else if (t.includes("thumbnail") || t.includes("jfxx")) {
      found.add("thumbnail");
    } else if (t === "text" || t === "ztxt" || t === "itxt" || t.includes("text")) {
      // PNG text chunks frequently carry AI prompts.
      found.add("ai");
      found.add("comments");
    } else if (t === "time") {
      found.add("dates");
    } else if (t.startsWith("app") || t.includes("iccp") || t === "iptc") {
      found.add("metadata");
    } else {
      found.add("metadata");
    }
  }
  return sortCategories(found);
}

export function categoryLabels(categories: MetadataCategory[]): string[] {
  return categories.map((category) => CATEGORY_LABELS[category]);
}
