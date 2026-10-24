// UI hierarchy reader for the Android guest.
//
// Why this exists: automation over the Local API had only a screenshot, so every click had to be
// aimed at hardcoded coordinates. `uiautomator dump` does expose the tree, but two traps make the
// naive call useless in practice:
//   1. It answers from a CACHE unless the old file is removed first — the operator sees a tree
//      from a previous screen ("stale hierarchy");
//   2. its `bounds` for some nodes are not normalised (`[21,2362][509,1397]` — bottom above top),
//      which turns into negative widths downstream.
// Both are handled here, once, so callers get a tree they can click by text.

/** One clickable/visible node, with bounds already normalised to x/y/w/h. */
export interface AndroidUiNode {
  text: string;
  contentDesc: string;
  resourceId: string;
  className: string;
  clickable: boolean;
  enabled: boolean;
  focused: boolean;
  bounds: { x: number; y: number; w: number; h: number };
}

export interface AndroidUiSnapshot {
  nodes: AndroidUiNode[];
  /** Raw XML, so a caller can debug a parse that lost a node. */
  xml?: string;
  /** True when the guest answered with a dump this call produced (never a cached file). */
  fresh: boolean;
  /** Set when the dump failed; `nodes` is then empty rather than silently stale. */
  error?: string;
}

const DUMP_PATH = '/sdcard/nulltrace-ui.xml';

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

function attr(attrs: string, name: string): string {
  const match = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return match ? decodeXmlEntities(match[1]) : '';
}

/**
 * Parses one `bounds="[x1,y1][x2,y2]"` into a normalised rect.
 *
 * The swap is deliberate: uiautomator occasionally emits the corners in the wrong order on
 * scrolled or animated layouts, and a raw pass-through turns that into a negative width that
 * silently misses every click. Taking min/max makes the rect usable regardless of corner order.
 */
export function parseBounds(raw: string): { x: number; y: number; w: number; h: number } | null {
  const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(raw);
  if (!match) return null;
  const x1 = Number(match[1]);
  const y1 = Number(match[2]);
  const x2 = Number(match[3]);
  const y2 = Number(match[4]);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  return { x: left, y: top, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/** Parses a `uiautomator dump` document into nodes. Regex-scanned: the XML is flat and stable. */
export function parseUiXml(xml: string): AndroidUiNode[] {
  const nodes: AndroidUiNode[] = [];
  const nodeRe = /<node\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = nodeRe.exec(xml)) !== null) {
    const attrs = match[1];
    const bounds = parseBounds(attr(attrs, 'bounds'));
    if (!bounds) continue;
    const text = attr(attrs, 'text');
    const contentDesc = attr(attrs, 'content-desc');
    const resourceId = attr(attrs, 'resource-id');
    const className = attr(attrs, 'class');
    // A node with no text, no description and no id is layout scaffolding: it can still be
    // clickable, but reporting thousands of empty frames buries the ones a caller wants.
    if (!text && !contentDesc && !resourceId && attr(attrs, 'clickable') !== 'true') continue;
    nodes.push({
      text,
      contentDesc,
      resourceId,
      className,
      clickable: attr(attrs, 'clickable') === 'true',
      enabled: attr(attrs, 'enabled') !== 'false',
      focused: attr(attrs, 'focused') === 'true',
      bounds,
    });
  }
  return nodes;
}

/**
 * Dumps and reads the current hierarchy. `shellCode` is used (not `shell`) so a refused dump is a
 * value, not an exception — the caller reports `error` instead of guessing at a stale tree.
 */
export async function readUiHierarchy(
  adb: { shellCode: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }> },
): Promise<AndroidUiSnapshot> {
  // The cache is the whole bug: without removing the previous file, `uiautomator dump` answers
  // "UI hierchary dumped to: ..." while leaving the OLD document in place.
  await adb.shellCode(['rm', '-f', DUMP_PATH]).catch(() => undefined);

  const dump = await adb.shellCode(['uiautomator', 'dump', DUMP_PATH]).catch((err: unknown) => ({
    stdout: '',
    stderr: err instanceof Error ? err.message : String(err),
    exitCode: 1,
  }));

  const read = await adb.shellCode(['cat', DUMP_PATH]);
  if (read.exitCode !== 0 || read.stdout.trim().length === 0) {
    return {
      nodes: [],
      fresh: false,
      error: `uiautomator dump produced no file (${dump.stdout.trim() || dump.stderr.trim() || 'no output'})`,
    };
  }

  const xml = read.stdout;
  return { nodes: parseUiXml(xml), xml, fresh: true };
}
