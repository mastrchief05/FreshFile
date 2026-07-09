import { DOMParser, XMLSerializer, type Element as XmlElement, type Node as XmlNode } from "@xmldom/xmldom";

export class SvgCleanerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SvgCleanerError";
  }
}

const ELEMENT_NODE = 1;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;

const blockedElements = new Set([
  "metadata",
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
  "canvas",
  "link",
  "rdf:rdf",
  "rdf",
  "desc",
  // <title> is a tooltip/accessibility label, not visible artwork, and a
  // common author/description metadata channel — dropped like <desc>.
  "title",
  // XML Events scripting element — pure behavior, no visible artwork.
  "handler"
]);

// SMIL animation elements can set arbitrary attributes on their target via
// attributeName. They are kept for legitimate animation (opacity, transform,
// ...) but removed when attributeName targets a scripting/navigation surface.
const animationElements = new Set([
  "animate",
  "set",
  "animatetransform",
  "animatemotion",
  "animatecolor"
]);

function animationTargetsUnsafeAttribute(element: XmlElement) {
  let target: string | null = null;
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute && localName(attribute.name) === "attributename") {
      target = attribute.value.trim().toLowerCase();
      break;
    }
  }
  if (!target) return false;
  const localTarget = target.split(":").pop() ?? target;
  return (
    localTarget.startsWith("on") ||
    urlAttributes.has(target) ||
    urlAttributes.has(localTarget) ||
    localTarget === "style" ||
    localTarget === "class"
  );
}

const urlAttributes = new Set([
  "href",
  "xlink:href",
  "src",
  "poster",
  "data",
  "formaction"
]);

function assertNoDoctype(svg: string) {
  if (/<!doctype/i.test(svg)) {
    throw new SvgCleanerError("SVG doctype declarations are not allowed.");
  }
}

function isSafeUrl(value: string) {
  const trimmed = value.trim().replace(/[\u0000-\u001F\u007F\s]+/g, "");
  if (trimmed.startsWith("#")) return true;
  if (/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=]+$/i.test(trimmed)) return true;
  return false;
}

function localName(name: string) {
  return name.toLowerCase().split(":").pop() ?? name.toLowerCase();
}

function sanitizeStyle(value: string) {
  if (/@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding|<|<\/|url\s*\(\s*(?!['"]?#)/i.test(value)) {
    return "";
  }

  return value;
}

function sanitizeAttributes(element: XmlElement) {
  const attributesToRemove: string[] = [];

  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (!attribute) continue;

    const name = attribute.name.toLowerCase();
    const localAttributeName = localName(attribute.name);
    const value = attribute.value;

    // Namespace policy: keep only the SVG default namespace plus a tiny
    // allowlist of safe prefixes (xml, xlink). Everything else — editor and
    // metadata namespaces (sodipodi, inkscape, Adobe i:/x:, sketch, dc, cc,
    // rdf, …) and their xmlns declarations — is stripped, closing channels
    // like sodipodi:docname (the original filename) and inkscape:label.
    const colon = name.indexOf(":");
    if (colon > 0) {
      const rawPrefix = name.slice(0, colon);
      const declaredPrefix = rawPrefix === "xmlns" ? name.slice(colon + 1) : rawPrefix;
      if (declaredPrefix !== "xml" && declaredPrefix !== "xlink") {
        attributesToRemove.push(attribute.name);
        continue;
      }
    }

    if (name.startsWith("on") || localAttributeName.startsWith("on")) {
      attributesToRemove.push(attribute.name);
      continue;
    }

    if ((urlAttributes.has(name) || urlAttributes.has(localAttributeName)) && !isSafeUrl(value)) {
      attributesToRemove.push(attribute.name);
      continue;
    }

    if (name === "style" || localAttributeName === "style") {
      const sanitized = sanitizeStyle(value);
      if (!sanitized) {
        attributesToRemove.push(attribute.name);
      } else {
        element.setAttribute(attribute.name, sanitized);
      }
    }
  }

  attributesToRemove.forEach((name) => element.removeAttribute(name));
}

function sanitizeStyleElement(element: XmlElement) {
  const text = element.textContent ?? "";
  const sanitized = sanitizeStyle(text);
  const ownerDocument = element.ownerDocument;
  if (!sanitized) {
    element.parentNode?.removeChild(element);
    return false;
  }

  if (!ownerDocument) {
    element.parentNode?.removeChild(element);
    return false;
  }

  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
  element.appendChild(ownerDocument.createTextNode(sanitized));
  return true;
}

function walkAndClean(node: XmlNode) {
  const children = Array.from({ length: node.childNodes.length }, (_, index) => node.childNodes.item(index)).filter(Boolean) as XmlNode[];

  for (const child of children) {
    if (child.nodeType === COMMENT_NODE || child.nodeType === PROCESSING_INSTRUCTION_NODE) {
      child.parentNode?.removeChild(child);
      continue;
    }

    if (child.nodeType !== ELEMENT_NODE) {
      continue;
    }

    const element = child as XmlElement;
    const tagName = localName(element.tagName);

    if (blockedElements.has(tagName)) {
      element.parentNode?.removeChild(element);
      continue;
    }

    if (animationElements.has(tagName) && animationTargetsUnsafeAttribute(element)) {
      element.parentNode?.removeChild(element);
      continue;
    }

    sanitizeAttributes(element);
    if (tagName === "style" && !sanitizeStyleElement(element)) {
      continue;
    }

    walkAndClean(element);
  }
}

export function validateSvgOutput(svg: string) {
  if (!/^\s*<(?:[a-z0-9_-]+:)?svg[\s>]/i.test(svg)) {
    throw new SvgCleanerError("Sanitized output is not an SVG.");
  }

  if (/<(?:[a-z0-9_-]+:)?(?:script|metadata|foreignobject|handler|title|desc)\b|(?:^|\s)(?:[a-z0-9_-]+:)?on[a-z0-9_-]+\s*=|javascript:|<!doctype|<!--/i.test(svg)) {
    throw new SvgCleanerError("Sanitized SVG still contains unsafe content.");
  }

  // Belt-and-suspenders: no animation may still target an event handler,
  // navigation, or style attribute after cleaning.
  if (/attributeName\s*=\s*["']\s*(?:[a-z0-9_-]+:)?(?:on[a-z0-9_-]+|href|xlink:href|src|style|class)\b/i.test(svg)) {
    throw new SvgCleanerError("Sanitized SVG still contains an unsafe animation target.");
  }

  return true;
}

export function cleanSvg(svg: string) {
  assertNoDoctype(svg);

  const parseErrors: string[] = [];
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level !== "warning") {
        parseErrors.push(String(message));
      }
    }
  });
  const document = parser.parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;

  if (!root || localName(root.tagName) !== "svg" || parseErrors.length > 0) {
    throw new SvgCleanerError("Invalid SVG.");
  }

  sanitizeAttributes(root);
  walkAndClean(root);

  const serialized = new XMLSerializer().serializeToString(root);
  validateSvgOutput(serialized);
  return serialized;
}
