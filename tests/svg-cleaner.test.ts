import { describe, expect, it } from "vitest";
import { cleanSvg } from "@/formats/svg-cleaner";

describe("SVG cleaner", () => {
  it("removes metadata, RDF, comments, script, and event handlers", () => {
    const cleaned = cleanSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" viewBox="0 0 10 10" onload="alert(1)">
        <!-- private prompt -->
        <metadata><rdf:RDF><rdf:Description>prompt</rdf:Description></rdf:RDF></metadata>
        <script>alert(1)</script>
        <rect width="10" height="10" fill="red" onclick="alert(1)" />
      </svg>
    `);

    expect(cleaned).toContain("<rect");
    expect(cleaned).toContain('fill="red"');
    expect(cleaned).not.toMatch(/metadata|rdf|script|onclick|onload|private prompt/i);
  });

  it("removes unsafe external references and preserves same-document references", () => {
    const cleaned = cleanSvg(`
      <svg xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="g"><stop stop-color="red" /></linearGradient></defs>
        <image href="https://example.com/a.png" />
        <rect fill="url(#g)" href="#local" />
      </svg>
    `);

    expect(cleaned).not.toContain("https://example.com");
    expect(cleaned).toContain("url(#g)");
    expect(cleaned).toContain('href="#local"');
  });

  it("removes namespaced active SVG content", () => {
    const cleaned = cleanSvg(`
      <svg:svg xmlns:svg="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
        <svg:script>alert(1)</svg:script>
        <svg:foreignObject><body>unsafe</body></svg:foreignObject>
        <svg:rect width="10" height="10" svg:onload="alert(1)" xlink:href="javascript:alert(1)" />
      </svg:svg>
    `);

    expect(cleaned).toContain("<svg:rect");
    expect(cleaned).not.toMatch(/script|foreignObject|onload|javascript:/i);
  });

  it("rejects doctypes", () => {
    expect(() => cleanSvg(`<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" />`)).toThrow(
      "doctype"
    );
  });

  it("removes SMIL animations that inject event handlers, keeps legitimate ones", () => {
    const cleaned = cleanSvg(`
      <svg xmlns="http://www.w3.org/2000/svg">
        <rect width="10" height="10" fill="red">
          <set attributeName="onclick" to="alert(1)" />
          <animate attributeName="href" to="javascript:alert(1)" />
          <animate attributeName="opacity" from="0" to="1" dur="1s" />
        </rect>
      </svg>
    `);

    expect(cleaned).not.toMatch(/onclick|javascript:/i);
    expect(cleaned).not.toMatch(/attributeName\s*=\s*["']onclick/i);
    // the harmless opacity animation survives
    expect(cleaned).toMatch(/attributeName\s*=\s*["']opacity/i);
  });

  it("removes the legacy <handler> scripting element", () => {
    const cleaned = cleanSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:ev="http://www.w3.org/2001/xml-events">
        <handler ev:event="load">alert(1)</handler>
        <rect width="10" height="10" fill="blue" />
      </svg>
    `);

    expect(cleaned).not.toMatch(/handler|alert/i);
    expect(cleaned).toContain("<rect");
  });

  it("blocks a <set> that animates the style attribute", () => {
    const cleaned = cleanSvg(`
      <svg xmlns="http://www.w3.org/2000/svg">
        <rect width="10" height="10">
          <set attributeName="style" to="background:url(javascript:alert(1))" />
        </rect>
      </svg>
    `);

    expect(cleaned).not.toMatch(/attributeName\s*=\s*["']style/i);
    expect(cleaned).not.toMatch(/javascript:/i);
  });
});
