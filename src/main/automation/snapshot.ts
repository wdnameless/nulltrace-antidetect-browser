export type SnapshotScope = 'viewport' | 'full_page' | 'subtree';

export interface SnapshotOptions {
  scope?: SnapshotScope;
  root?: string; // root = '@N' or 'ref=N' or 'N'
  pageLabel?: string;
}

export interface SnapshotResult {
  text: string;     // compact role tree, refs like [ref=21]
  refs: string[];   // all refs present in text, for validation
  truncated: boolean;
}

export interface RefRecord {
  frameId: string;
  backendNodeId: number;
}

export interface ClipRect {
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
}

export interface CDPSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface AXValue {
  type?: string;
  value?: unknown;
}

export interface AXNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: AXValue | string;
  name?: AXValue | string;
  description?: AXValue | string;
  value?: AXValue | string;
  childIds?: string[];
  parentId?: string;
  ignored?: boolean;
  frameId?: string;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface DomNodeLike {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  children?: DomNodeLike[];
  shadowRoots?: DomNodeLike[];
  shadowRootType?: 'open' | 'closed' | 'user-agent';
  contentDocument?: DomNodeLike;
  frameId?: string;
  box?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Global @ref registry: per (profileId, pageLabel) -> Map<normalizedRef, RefRecord>.
 * Full snapshot replaces existing entries; subtree snapshot retains existing entries.
 */
const refRegistry = new Map<string, Map<string, RefRecord>>();

export function normalizeRefKey(ref: string): string {
  if (ref.startsWith('ref=')) {
    return ref.slice(4);
  }
  if (ref.startsWith('@')) {
    return ref.slice(1);
  }
  return ref;
}

/**
 * Resolves a ref identifier ('@21', 'ref=21', or '21') from the registry
 * for a specific profile and page label.
 */
export function resolveRef(
  profileId: string,
  pageLabel: string,
  ref: string
): { frameId: string; backendNodeId: number } | null {
  const pageMap = refRegistry.get(`${profileId}:${pageLabel}`);
  if (!pageMap) {
    return null;
  }
  const cleanKey = normalizeRefKey(ref);
  const found = pageMap.get(cleanKey);
  if (!found) {
    return null;
  }
  return {
    frameId: found.frameId,
    backendNodeId: found.backendNodeId,
  };
}

/**
 * Invalidates refs in the registry.
 * If pageLabel is specified, invalidates only that page;
 * otherwise invalidates all pages under profileId (e.g. on profile navigation/reset).
 */
export function invalidateRefs(profileId: string, pageLabel?: string): void {
  if (pageLabel !== undefined) {
    refRegistry.delete(`${profileId}:${pageLabel}`);
  } else {
    const prefix = `${profileId}:`;
    for (const key of Array.from(refRegistry.keys())) {
      if (key.startsWith(prefix)) {
        refRegistry.delete(key);
      }
    }
  }
}

/**
 * Computes CSS-pixel scale factor for screenshots (R05).
 * clip.scale = 1 / devicePixelRatio
 */
export function computeCssScale(devicePixelRatio: number): number {
  if (!devicePixelRatio || devicePixelRatio <= 0 || !Number.isFinite(devicePixelRatio)) {
    return 1;
  }
  return 1 / devicePixelRatio;
}

/**
 * Adjusts screenshot clip rectangle with CSS scale factor (R05).
 */
export function computeCssClip(clip: ClipRect, devicePixelRatio: number): ClipRect & { scale: number } {
  return {
    ...clip,
    scale: computeCssScale(devicePixelRatio),
  };
}

const INTERACTIVE_ROLES: Record<string, true> = {
  button: true,
  link: true,
  textbox: true,
  searchbox: true,
  combobox: true,
  listbox: true,
  checkbox: true,
  radio: true,
  switch: true,
  menuitem: true,
  menuitemcheckbox: true,
  menuitemradio: true,
  tab: true,
  slider: true,
  spinbutton: true,
  treeitem: true,
  option: true,
  input: true,
};

function readAxString(val: AXValue | string | undefined): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  const raw = val.value;
  if (typeof raw === 'string') return raw;
  if (raw !== undefined && raw !== null) return String(raw);
  return '';
}

function hasSend(val: unknown): val is CDPSessionLike {
  return typeof val === 'object' && val !== null && 'send' in val && typeof val.send === 'function';
}

export async function resolveCdpSession(page: unknown): Promise<CDPSessionLike> {
  if (hasSend(page)) {
    return page;
  }
  if (typeof page === 'object' && page !== null) {
    if ('createCDPSession' in page && typeof page.createCDPSession === 'function') {
      const created = await page.createCDPSession();
      if (hasSend(created)) {
        return created;
      }
    }
    if ('_client' in page && hasSend(page._client)) {
      return page._client;
    }
  }
  throw new Error('Invalid page target: cannot obtain CDP session');
}

export function getDomNodeAttributes(node: DomNodeLike): Record<string, string> {
  const record: Record<string, string> = {};
  if (!node.attributes) return record;
  for (let i = 0; i < node.attributes.length; i += 2) {
    record[node.attributes[i].toLowerCase()] = node.attributes[i + 1] || '';
  }
  return record;
}

export function getDomNodeText(node: DomNodeLike): string {
  let text = '';
  if (node.nodeType === 3 && node.nodeValue) {
    text += node.nodeValue;
  }
  if (node.children) {
    for (const child of node.children) {
      text += getDomNodeText(child);
    }
  }
  return text;
}

export function deriveRoleFromTag(tag: string, attrs: Record<string, string>): string {
  const upper = tag.toUpperCase();
  if (attrs.role) {
    return attrs.role;
  }
  switch (upper) {
    case 'BUTTON':
      return 'button';
    case 'A':
      return attrs.href !== undefined ? 'link' : 'generic';
    case 'INPUT': {
      const type = (attrs.type || 'text').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    case 'TEXTAREA':
      return 'textbox';
    case 'SELECT':
      return 'combobox';
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return 'heading';
    case 'NAV':
      return 'navigation';
    case 'MAIN':
      return 'main';
    case '#DOCUMENT':
      return 'RootWebArea';
    default:
      return upper.toLowerCase();
  }
}

export function hasBalancedDelimiters(input: string): boolean {
  let openBrackets = 0;
  let openParens = 0;
  let inDoubleQuote = false;
  let inSingleQuote = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"' && !inSingleQuote && (i === 0 || input[i - 1] !== '\\')) {
      inDoubleQuote = !inDoubleQuote;
    } else if (ch === "'" && !inDoubleQuote && (i === 0 || input[i - 1] !== '\\')) {
      inSingleQuote = !inSingleQuote;
    } else if (!inDoubleQuote && !inSingleQuote) {
      if (ch === '[') openBrackets++;
      else if (ch === ']') openBrackets--;
      else if (ch === '(') openParens++;
      else if (ch === ')') openParens--;
      if (openBrackets < 0 || openParens < 0) return false;
    }
  }

  return !inDoubleQuote && !inSingleQuote && openBrackets === 0 && openParens === 0;
}

/**
 * Converts a DOM tree into an array of pseudo-AX nodes for snapshot rendering.
 */
function domToAxNodes(rootNode: DomNodeLike, frameId = 'main_frame'): AXNode[] {
  const result: AXNode[] = [];

  function traverse(node: DomNodeLike, parentId?: string, currentFrameId = frameId): string | null {
    if (node.nodeType === 3) {
      return null;
    }

    const currentId = String(node.nodeId || node.backendNodeId);
    const attrs = getDomNodeAttributes(node);
    const role = deriveRoleFromTag(node.nodeName || '', attrs);

    let name = attrs['aria-label'] || attrs.title || attrs.alt;
    if (!name && (node.nodeName || '').toUpperCase() !== '#DOCUMENT') {
      name = getDomNodeText(node).trim();
    }
    const value = attrs.value || '';

    const axNode: AXNode = {
      nodeId: currentId,
      backendDOMNodeId: node.backendNodeId,
      role: { type: 'role', value: role },
      name: { type: 'computedString', value: name || '' },
      value: value ? { type: 'value', value } : undefined,
      parentId,
      frameId: currentFrameId,
      bounds: node.box,
      childIds: [],
    };
    result.push(axNode);

    if (node.children) {
      for (const child of node.children) {
        const childId = traverse(child, currentId, currentFrameId);
        if (childId && axNode.childIds) {
          axNode.childIds.push(childId);
        }
      }
    }

    if (node.shadowRoots) {
      for (const sr of node.shadowRoots) {
        if (sr.shadowRootType === 'open' || !sr.shadowRootType) {
          if (sr.children) {
            for (const child of sr.children) {
              const childId = traverse(child, currentId, currentFrameId);
              if (childId && axNode.childIds) {
                axNode.childIds.push(childId);
              }
            }
          }
        }
      }
    }

    if (node.contentDocument) {
      const subFrameId = node.contentDocument.frameId || node.frameId || `${currentFrameId}_sub`;
      const docChildId = traverse(node.contentDocument, currentId, subFrameId);
      if (docChildId && axNode.childIds) {
        axNode.childIds.push(docChildId);
      }
    }

    return currentId;
  }

  traverse(rootNode);
  return result;
}

function resolvePageLabel(page: unknown, opts?: SnapshotOptions): string {
  if (opts?.pageLabel) {
    return opts.pageLabel;
  }
  if (page && typeof page === 'object') {
    if ('__pageLabel' in page && typeof page.__pageLabel === 'string') {
      return page.__pageLabel;
    }
    if ('label' in page && typeof page.label === 'string') {
      return page.label;
    }
  }
  return 'p1';
}

function parseAxNodesResponse(resp: unknown): AXNode[] {
  if (resp && typeof resp === 'object' && 'nodes' in resp && Array.isArray(resp.nodes)) {
    return resp.nodes.filter(
      (item): item is AXNode => typeof item === 'object' && item !== null && 'nodeId' in item
    );
  }
  return [];
}

export function parseDomRootResponse(resp: unknown): DomNodeLike | null {
  if (resp && typeof resp === 'object' && 'root' in resp) {
    const root = resp.root;
    if (typeof root === 'object' && root !== null && 'nodeId' in root) {
      return root as DomNodeLike;
    }
  }
  return null;
}

/**
 * Captures a semantic snapshot of the page using CDP Accessibility and DOM.
 * R01: compact role tree naming interactive elements with stable @ref identifiers.
 * R05: clip scale math support.
 * Scope:
 * - 'viewport' (default): only nodes currently in viewport
 * - 'full_page': all nodes in document
 * - 'subtree': focused on root @ref element
 */
export async function captureSnapshot(
  profileId: string,
  page: unknown,
  opts?: SnapshotOptions
): Promise<SnapshotResult> {
  const session = await resolveCdpSession(page);
  const pageLabel = resolvePageLabel(page, opts);
  const scope: SnapshotScope = opts?.scope || 'viewport';

  let axNodes: AXNode[] = [];

  try {
    const axResp = await session.send('Accessibility.getFullAXTree', {});
    axNodes = parseAxNodesResponse(axResp);
  } catch {
    // Accessibility domain may not be enabled or supported; fallback to DOM
  }

  if (axNodes.length === 0) {
    try {
      const domResp = await session.send('DOM.getDocument', { depth: -1, pierce: true });
      const rootNode = parseDomRootResponse(domResp);
      if (rootNode) {
        axNodes = domToAxNodes(rootNode);
      }
    } catch {
      // Ignore fallback failure
    }
  }

  if (axNodes.length === 0) {
    return {
      text: '',
      refs: [],
      truncated: false,
    };
  }

  const regKey = `${profileId}:${pageLabel}`;
  let pageMap: Map<string, RefRecord>;

  let nextRefIndex = 1;
  if (scope === 'subtree') {
    pageMap = refRegistry.get(regKey) || new Map<string, RefRecord>();
    refRegistry.set(regKey, pageMap);

    let maxNum = 0;
    for (const k of pageMap.keys()) {
      const n = parseInt(k, 10);
      if (!isNaN(n) && n > maxNum) {
        maxNum = n;
      }
    }
    nextRefIndex = maxNum + 1;
  } else {
    pageMap = new Map<string, RefRecord>();
    refRegistry.set(regKey, pageMap);
  }

  const nodeMap = new Map<string, AXNode>();
  for (const n of axNodes) {
    nodeMap.set(String(n.nodeId), n);
  }

  let rootNodeId: string | null = null;
  if (scope === 'subtree' && opts?.root) {
    const targetRef = opts.root;
    const resolvedRoot = resolveRef(profileId, pageLabel, targetRef);
    if (!resolvedRoot) {
      throw new Error(`Subtree root ref "${targetRef}" not found in registry for ${profileId}:${pageLabel}`);
    }
    const found = axNodes.find((n) => n.backendDOMNodeId === resolvedRoot.backendNodeId);
    if (found) {
      rootNodeId = String(found.nodeId);
    } else {
      const frameMatch = axNodes.find((n) => n.frameId === resolvedRoot.frameId);
      if (frameMatch) {
        rootNodeId = String(frameMatch.nodeId);
      }
    }
    if (!rootNodeId) {
      throw new Error(`Subtree root node for ref "${targetRef}" not found in AX tree`);
    }
  }

  let vpWidth = 1280;
  let vpHeight = 800;
  if (scope === 'viewport') {
    try {
      const metrics = await session.send('Page.getLayoutMetrics', {});
      if (metrics && typeof metrics === 'object') {
        let visualWidth: number | undefined;
        let layoutHeight: number | undefined;

        if ('visualViewport' in metrics && typeof metrics.visualViewport === 'object' && metrics.visualViewport !== null) {
          const vv = metrics.visualViewport;
          if ('clientWidth' in vv && typeof vv.clientWidth === 'number') visualWidth = vv.clientWidth;
          else if ('width' in vv && typeof vv.width === 'number') visualWidth = vv.width;
        }
        if (!visualWidth && 'cssVisualViewport' in metrics && typeof metrics.cssVisualViewport === 'object' && metrics.cssVisualViewport !== null) {
          const cv = metrics.cssVisualViewport;
          if ('clientWidth' in cv && typeof cv.clientWidth === 'number') visualWidth = cv.clientWidth;
        }
        if ('layoutViewport' in metrics && typeof metrics.layoutViewport === 'object' && metrics.layoutViewport !== null) {
          const lv = metrics.layoutViewport;
          if ('clientHeight' in lv && typeof lv.clientHeight === 'number') layoutHeight = lv.clientHeight;
          else if ('height' in lv && typeof lv.height === 'number') layoutHeight = lv.height;
        }

        if (visualWidth) vpWidth = visualWidth;
        if (layoutHeight) vpHeight = layoutHeight;
      }
    } catch {
      // Use defaults if Page.getLayoutMetrics not supported
    }
  }

  function isNodeInViewport(node: AXNode): boolean {
    if (scope !== 'viewport') return true;
    if (!node.bounds) return true;
    const { x, y, width, height } = node.bounds;
    if (width <= 0 && height <= 0) return false;
    return x < vpWidth && x + width > 0 && y < vpHeight && y + height > 0;
  }

  const lines: string[] = [];
  const refs: string[] = [];
  const visited = new Set<string>();

  let rootsToRender: AXNode[] = [];
  if (rootNodeId) {
    const rootNode = nodeMap.get(rootNodeId);
    if (rootNode) rootsToRender = [rootNode];
  } else {
    rootsToRender = axNodes.filter((n) => !n.parentId || !nodeMap.has(String(n.parentId)));
    if (rootsToRender.length === 0 && axNodes.length > 0) {
      rootsToRender = [axNodes[0]];
    }
  }

  function renderChildren(node: AXNode, depth: number): void {
    if (node.childIds && node.childIds.length > 0) {
      for (const childId of node.childIds) {
        const child = nodeMap.get(String(childId));
        if (child) {
          renderNode(child, depth);
        }
      }
    }
  }

  function renderNode(node: AXNode, depth: number): void {
    const id = String(node.nodeId);
    if (visited.has(id)) return;
    visited.add(id);

    const rawRole = readAxString(node.role);
    let role = rawRole.toLowerCase() || 'generic';
    if (role === 'rootwebarea') {
      role = 'RootWebArea';
    }

    // Ignored layout containers ("none") and inline text runs carry no
    // renderable content of their own, but real AX trees nest the entire page
    // beneath them — skip the line, still walk the children (same depth).
    if (node.ignored || role === 'none' || role === 'inlinetextbox') {
      renderChildren(node, depth);
      return;
    }

    const name = readAxString(node.name);
    const value = readAxString(node.value);
    const inVp = isNodeInViewport(node);
    const isInteractive = INTERACTIVE_ROLES[role.toLowerCase()] === true;

    let refNum: number | null = null;
    if (inVp && isInteractive) {
      refNum = nextRefIndex++;
      const refKey = String(refNum);
      const backendNodeId = node.backendDOMNodeId || Number(node.nodeId) || refNum;
      const frameId = node.frameId || 'main_frame';

      const record: RefRecord = { frameId, backendNodeId };
      pageMap.set(refKey, record);
      pageMap.set(`@${refKey}`, record);
      pageMap.set(`ref=${refKey}`, record);

      refs.push(`@${refKey}`);
    }

    if (inVp) {
      const indent = '  '.repeat(depth);
      let line = `${indent}- ${role}`;
      if (name) {
        line += ` "${name}"`;
      }
      if (value) {
        line += ` [value="${value}"]`;
      }
      if (refNum !== null) {
        line += ` [ref=${refNum}]`;
      }
      lines.push(line);
    }

    renderChildren(node, inVp ? depth + 1 : depth);
  }

  for (const root of rootsToRender) {
    renderNode(root, 0);
  }

  let text = lines.join('\n');
  let truncated = false;

  const MAX_LINES = 1000;
  const MAX_CHARS = 50000;
  if (lines.length > MAX_LINES || text.length > MAX_CHARS) {
    const truncatedLines = lines.slice(0, MAX_LINES);
    text = truncatedLines.join('\n') + '\n... [truncated]';
    truncated = true;
  }

  return {
    text,
    refs,
    truncated,
  };
}
