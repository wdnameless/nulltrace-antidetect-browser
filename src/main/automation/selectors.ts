import {
  resolveRef,
  computeCssClip,
  computeCssScale,
  hasBalancedDelimiters,
  getDomNodeAttributes,
  getDomNodeText,
  deriveRoleFromTag,
  type CDPSessionLike,
  type DomNodeLike,
  type ClipRect,
} from './snapshot';

export { computeCssClip, computeCssScale, type ClipRect };

export type SelectorType = 'ref' | 'text' | 'css' | 'role' | 'href' | 'xpath';

export interface ParsedSelector {
  type: SelectorType;
  value: string;
  raw: string;
  exact?: boolean;
  role?: string;
  name?: string;
}

export interface ResolvedNode {
  backendNodeId: number;
  frameId: string;
  nodeId?: number;
  objectId?: string;
  role?: string;
  name?: string;
  box?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

function isValidCssSyntax(selector: string): boolean {
  const trimmed = selector.trim();
  if (trimmed.length === 0) return false;
  if (/^\d/.test(trimmed)) return false;
  if (/^[;,!%^&+=~|]/.test(trimmed) || /[,>+~]$/.test(trimmed)) return false;
  if (/:\s*[),;>]|:\s*$/.test(trimmed)) return false;
  return hasBalancedDelimiters(trimmed);
}

function isValidXPathSyntax(xpath: string): boolean {
  const trimmed = xpath.trim();
  if (trimmed.length === 0) return false;
  return hasBalancedDelimiters(trimmed);
}

/**
 * Parses an automation selector into its typed representation.
 * Grammar: @21 | ref=21 | text=… | text="…" | loc=css:… | loc=role:… | loc=href:… | xpath=… | raw CSS
 * Throws an Error if selector syntax is invalid.
 */
export function parseSelector(sel: string): ParsedSelector {
  if (typeof sel !== 'string' || sel.trim().length === 0) {
    throw new Error('Selector must be a non-empty string');
  }

  const trimmed = sel.trim();

  // @21 ref syntax
  if (trimmed.startsWith('@')) {
    const match = /^@([a-zA-Z0-9_-]+)$/.exec(trimmed);
    if (!match) {
      throw new Error(`Invalid @ref selector: "${sel}"`);
    }
    return { type: 'ref', value: match[1], raw: sel };
  }

  // ref=21 syntax
  if (trimmed.startsWith('ref=')) {
    const match = /^ref=([a-zA-Z0-9_-]+)$/.exec(trimmed);
    if (!match) {
      throw new Error(`Invalid ref= selector: "${sel}"`);
    }
    return { type: 'ref', value: match[1], raw: sel };
  }

  // text= and text="…" syntax
  if (trimmed.startsWith('text=')) {
    const rest = trimmed.slice(5);
    if (rest.length === 0) {
      throw new Error(`Invalid text selector (empty target): "${sel}"`);
    }
    if (rest.startsWith('"')) {
      if (!rest.endsWith('"') || rest.length < 2) {
        throw new Error(`Invalid text selector (unclosed double quote): "${sel}"`);
      }
      return { type: 'text', value: rest.slice(1, -1), exact: true, raw: sel };
    }
    if (rest.startsWith("'")) {
      if (!rest.endsWith("'") || rest.length < 2) {
        throw new Error(`Invalid text selector (unclosed single quote): "${sel}"`);
      }
      return { type: 'text', value: rest.slice(1, -1), exact: true, raw: sel };
    }
    if (rest.trim().length === 0) {
      throw new Error(`Invalid text selector (empty text): "${sel}"`);
    }
    return { type: 'text', value: rest, exact: false, raw: sel };
  }

  // loc= syntax
  if (trimmed.startsWith('loc=')) {
    const rest = trimmed.slice(4);
    if (rest.startsWith('css:')) {
      const css = rest.slice(4).trim();
      if (css.length === 0 || !isValidCssSyntax(css)) {
        throw new Error(`Invalid CSS locator: "${sel}"`);
      }
      return { type: 'css', value: css, raw: sel };
    }
    if (rest.startsWith('role:')) {
      const roleTarget = rest.slice(5).trim();
      if (roleTarget.length === 0) {
        throw new Error(`Invalid role locator (empty): "${sel}"`);
      }
      const roleMatch = /^([a-zA-Z0-9_-]+)(?:\[name=(?:"([^"]*)"|'([^']*)'|([^\]]+))\])?$/.exec(roleTarget);
      if (!roleMatch) {
        throw new Error(`Invalid role locator syntax: "${sel}"`);
      }
      const roleName = roleMatch[1];
      const name = roleMatch[2] ?? roleMatch[3] ?? roleMatch[4];
      return {
        type: 'role',
        value: roleTarget,
        role: roleName,
        name,
        raw: sel,
      };
    }
    if (rest.startsWith('href:')) {
      const href = rest.slice(5).trim();
      if (href.length === 0) {
        throw new Error(`Invalid href locator (empty): "${sel}"`);
      }
      return { type: 'href', value: href, raw: sel };
    }
    throw new Error(`Unknown locator prefix: "${sel}"`);
  }

  // xpath= syntax
  if (trimmed.startsWith('xpath=')) {
    const xpath = trimmed.slice(6).trim();
    if (xpath.length === 0 || !isValidXPathSyntax(xpath)) {
      throw new Error(`Invalid xpath selector: "${sel}"`);
    }
    return { type: 'xpath', value: xpath, raw: sel };
  }

  // Raw CSS selector
  if (!isValidCssSyntax(trimmed)) {
    throw new Error(`Invalid CSS selector: "${sel}"`);
  }

  return { type: 'css', value: trimmed, raw: sel };
}

function matchSimpleCompound(
  node: DomNodeLike,
  selector: string,
  attrs: Record<string, string>
): boolean {
  if (node.nodeType !== 1) return false;

  let current = selector.trim();
  const tagMatch = /^([a-zA-Z0-9*_-]+)/.exec(current);
  if (tagMatch) {
    const expectedTag = tagMatch[1].toUpperCase();
    if (expectedTag !== '*' && (node.nodeName || '').toUpperCase() !== expectedTag) {
      return false;
    }
    current = current.slice(tagMatch[0].length);
  }

  while (current.length > 0) {
    if (current.startsWith('#')) {
      const idMatch = /^#([a-zA-Z0-9_-]+)/.exec(current);
      if (!idMatch) return false;
      if (attrs.id !== idMatch[1]) return false;
      current = current.slice(idMatch[0].length);
    } else if (current.startsWith('.')) {
      const classMatch = /^\.([a-zA-Z0-9_-]+)/.exec(current);
      if (!classMatch) return false;
      const classList = (attrs.class || '').split(/\s+/).filter(Boolean);
      if (!classList.includes(classMatch[1])) return false;
      current = current.slice(classMatch[0].length);
    } else if (current.startsWith('[')) {
      const attrMatch = /^\[([a-zA-Z0-9_-]+)(?:([*^$]?=)(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/.exec(current);
      if (!attrMatch) return false;
      const attrName = attrMatch[1].toLowerCase();
      const op = attrMatch[2];
      const expectedVal = attrMatch[3] ?? attrMatch[4] ?? attrMatch[5];

      if (attrs[attrName] === undefined) return false;
      if (op && expectedVal !== undefined) {
        const actualVal = attrs[attrName];
        if (op === '=' && actualVal !== expectedVal) return false;
        if (op === '*=' && !actualVal.includes(expectedVal)) return false;
        if (op === '^=' && !actualVal.startsWith(expectedVal)) return false;
        if (op === '$=' && !actualVal.endsWith(expectedVal)) return false;
      }
      current = current.slice(attrMatch[0].length);
    } else {
      break;
    }
  }

  return current.length === 0;
}

function matchCssOnNode(
  node: DomNodeLike,
  selector: string,
  parentMap: Map<DomNodeLike, DomNodeLike>
): boolean {
  if (node.nodeType !== 1) return false;

  if (selector.includes(',')) {
    const parts = selector.split(',').map((s) => s.trim());
    return parts.some((p) => matchCssOnNode(node, p, parentMap));
  }

  if (selector.includes('>')) {
    const parts = selector.split('>').map((s) => s.trim());
    const childSel = parts[parts.length - 1];
    const parentSel = parts.slice(0, -1).join(' > ');

    const attrs = getDomNodeAttributes(node);
    if (!matchSimpleCompound(node, childSel, attrs)) {
      return false;
    }
    const parentNode = parentMap.get(node);
    if (!parentNode) return false;
    return matchCssOnNode(parentNode, parentSel, parentMap);
  }

  if (selector.includes(' ')) {
    const parts = selector.split(/\s+/).filter(Boolean);
    const targetSel = parts[parts.length - 1];
    const ancestorSel = parts.slice(0, -1).join(' ');

    const attrs = getDomNodeAttributes(node);
    if (!matchSimpleCompound(node, targetSel, attrs)) {
      return false;
    }
    let curr = parentMap.get(node);
    while (curr) {
      if (matchCssOnNode(curr, ancestorSel, parentMap)) {
        return true;
      }
      curr = parentMap.get(curr);
    }
    return false;
  }

  const attrs = getDomNodeAttributes(node);
  return matchSimpleCompound(node, selector, attrs);
}

function matchTextOnNode(
  node: DomNodeLike,
  text: string,
  exact: boolean
): boolean {
  if (node.nodeType !== 1) return false;

  const content = getDomNodeText(node).trim();
  const isMatch = exact
    ? content === text.trim()
    : content.toLowerCase().includes(text.toLowerCase());

  if (!isMatch) return false;

  // Leaf check: don't match container if an element child also matches the text
  if (node.children) {
    for (const child of node.children) {
      if (child.nodeType === 1 && matchTextOnNode(child, text, exact)) {
        return false;
      }
    }
  }

  return true;
}

function matchRoleOnNode(
  node: DomNodeLike,
  targetRole: string,
  targetName: string | undefined,
  attrs: Record<string, string>
): boolean {
  if (node.nodeType !== 1) return false;

  const computedRole = deriveRoleFromTag(node.nodeName || '', attrs);
  if (computedRole.toLowerCase() !== targetRole.toLowerCase()) {
    return false;
  }

  if (targetName) {
    const accessibleName =
      attrs['aria-label'] || attrs.title || attrs.alt || attrs.placeholder || getDomNodeText(node).trim();
    if (!accessibleName.toLowerCase().includes(targetName.toLowerCase())) {
      return false;
    }
  }

  return true;
}

function matchHrefOnNode(
  node: DomNodeLike,
  hrefTarget: string,
  attrs: Record<string, string>
): boolean {
  if (node.nodeType !== 1) return false;
  const href = attrs.href;
  if (!href) return false;
  return href === hrefTarget || href.endsWith(hrefTarget) || href.includes(hrefTarget);
}

function matchXPathOnNode(
  node: DomNodeLike,
  xpath: string,
  attrs: Record<string, string>
): boolean {
  if (node.nodeType !== 1) return false;

  const tagMatch = /^\/\/(?:([a-zA-Z0-9*_-]+)|\*)(?:\[(.*)\])?$/.exec(xpath);
  if (!tagMatch) {
    return false;
  }

  const expectedTag = (tagMatch[1] || '*').toUpperCase();
  if (expectedTag !== '*' && (node.nodeName || '').toUpperCase() !== expectedTag) {
    return false;
  }

  const condition = tagMatch[2];
  if (!condition) {
    return true;
  }

  const attrCond = /^@([a-zA-Z0-9_-]+)=(?:"([^"]*)"|'([^']*)')$/.exec(condition);
  if (attrCond) {
    const attrName = attrCond[1].toLowerCase();
    const expectedVal = attrCond[2] ?? attrCond[3];
    return attrs[attrName] === expectedVal;
  }

  const textCond = /^text\(\)=(?:"([^"]*)"|'([^']*)')$/.exec(condition);
  if (textCond) {
    const expectedText = textCond[1] ?? textCond[2];
    return getDomNodeText(node).trim() === expectedText;
  }

  return false;
}

function nodeMatchesSelector(
  node: DomNodeLike,
  parsed: ParsedSelector,
  parentMap: Map<DomNodeLike, DomNodeLike>
): boolean {
  const attrs = getDomNodeAttributes(node);
  switch (parsed.type) {
    case 'css':
      return matchCssOnNode(node, parsed.value, parentMap);
    case 'text':
      return matchTextOnNode(node, parsed.value, parsed.exact ?? false);
    case 'role':
      return matchRoleOnNode(node, parsed.role || parsed.value, parsed.name, attrs);
    case 'href':
      return matchHrefOnNode(node, parsed.value, attrs);
    case 'xpath':
      return matchXPathOnNode(node, parsed.value, attrs);
    case 'ref':
      return false;
  }
}

async function resolveCdpSession(page: unknown): Promise<CDPSessionLike> {
  if (typeof page === 'object' && page !== null) {
    if ('send' in page && typeof page.send === 'function') {
      return page as CDPSessionLike;
    }
    if ('createCDPSession' in page && typeof page.createCDPSession === 'function') {
      const created = await page.createCDPSession();
      if (typeof created === 'object' && created !== null && 'send' in created && typeof created.send === 'function') {
        return created as CDPSessionLike;
      }
    }
    if ('_client' in page) {
      const client = page._client;
      if (typeof client === 'object' && client !== null && 'send' in client && typeof client.send === 'function') {
        return client as CDPSessionLike;
      }
    }
  }
  throw new Error('Invalid page target: cannot obtain CDP session');
}

function parseDomRoot(resp: unknown): DomNodeLike | null {
  if (resp && typeof resp === 'object' && 'root' in resp) {
    const root = resp.root;
    if (typeof root === 'object' && root !== null && 'nodeId' in root) {
      return root as DomNodeLike;
    }
  }
  return null;
}

/**
 * Resolves an automation selector against the page and returns exactly one element or throws.
 * Top-document first, then frames; open shadow roots traversed.
 * Ambiguity is an error.
 */
export async function resolveSelector(
  page: unknown,
  sel: string,
  profileId: string,
  pageLabel: string
): Promise<ResolvedNode> {
  const parsed = parseSelector(sel);

  if (parsed.type === 'ref') {
    const refRecord = resolveRef(profileId, pageLabel, parsed.value);
    if (!refRecord) {
      throw new Error(`Ref "${sel}" not found in registry for ${profileId}:${pageLabel}`);
    }
    return {
      backendNodeId: refRecord.backendNodeId,
      frameId: refRecord.frameId,
    };
  }

  const session = await resolveCdpSession(page);
  const domResp = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const root = parseDomRoot(domResp);
  if (!root) {
    throw new Error(`Unable to retrieve DOM tree from page for selector "${sel}"`);
  }

  const parentMap = new Map<DomNodeLike, DomNodeLike>();
  const frameDocuments: Array<{ doc: DomNodeLike; frameId: string }> = [];

  function buildHierarchy(node: DomNodeLike, currentFrameId: string, isTopDoc: boolean): void {
    if (node.children) {
      for (const child of node.children) {
        parentMap.set(child, node);
        buildHierarchy(child, currentFrameId, isTopDoc);
      }
    }

    if (node.shadowRoots) {
      for (const sr of node.shadowRoots) {
        if (sr.shadowRootType === 'open' || !sr.shadowRootType) {
          parentMap.set(sr, node);
          if (sr.children) {
            for (const child of sr.children) {
              parentMap.set(child, sr);
              buildHierarchy(child, currentFrameId, isTopDoc);
            }
          }
        }
      }
    }

    if (node.contentDocument) {
      const subFrameId = node.contentDocument.frameId || node.frameId || `${currentFrameId}_sub`;
      frameDocuments.push({ doc: node.contentDocument, frameId: subFrameId });
      buildHierarchy(node.contentDocument, subFrameId, false);
    }
  }

  buildHierarchy(root, 'main_frame', true);

  function collectMatches(node: DomNodeLike, frameId: string): ResolvedNode[] {
    const matches: ResolvedNode[] = [];

    function search(curr: DomNodeLike): void {
      if (curr.nodeType === 1 && nodeMatchesSelector(curr, parsed, parentMap)) {
        matches.push({
          backendNodeId: curr.backendNodeId,
          frameId,
          nodeId: curr.nodeId,
          box: curr.box,
        });
      }

      if (curr.children) {
        for (const child of curr.children) {
          search(child);
        }
      }

      if (curr.shadowRoots) {
        for (const sr of curr.shadowRoots) {
          if (sr.shadowRootType === 'open' || !sr.shadowRootType) {
            if (sr.children) {
              for (const child of sr.children) {
                search(child);
              }
            }
          }
        }
      }
    }

    search(node);
    return matches;
  }

  // Phase 1: Search top document first (including its open shadow roots)
  const topMatches = collectMatches(root, 'main_frame');
  if (topMatches.length === 1) {
    return topMatches[0];
  }
  if (topMatches.length > 1) {
    throw new Error(`Ambiguous selector: "${sel}" matched ${topMatches.length} elements in top document`);
  }

  // Phase 2: If no matches in top document, search child frames
  const frameMatches: ResolvedNode[] = [];
  for (const { doc, frameId } of frameDocuments) {
    const foundInFrame = collectMatches(doc, frameId);
    frameMatches.push(...foundInFrame);
  }

  if (frameMatches.length === 1) {
    return frameMatches[0];
  }
  if (frameMatches.length > 1) {
    throw new Error(`Ambiguous selector: "${sel}" matched ${frameMatches.length} elements across frames`);
  }

  throw new Error(`Selector "${sel}" matched no elements`);
}
