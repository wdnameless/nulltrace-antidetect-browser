import { describe, it, expect, beforeEach } from 'vitest';
import {
  captureSnapshot,
  resolveRef,
  invalidateRefs,
  type AXNode,
  type DomNodeLike,
} from '../../../src/main/automation/snapshot';

describe('snapshot — captureSnapshot and registry (tasks.md §1.2, interfaces.md §A, R01)', () => {
  const profileId = 'prof_snap_test';
  const pageLabel = 'p1';

  beforeEach(() => {
    invalidateRefs(profileId);
  });

  function makeAxMockSession(nodes: AXNode[]) {
    return {
      send: async (method: string) => {
        if (method === 'Accessibility.getFullAXTree') {
          return { nodes };
        }
        if (method === 'Page.getLayoutMetrics') {
          return {
            layoutViewport: { clientWidth: 1280, clientHeight: 800 },
          };
        }
        return {};
      },
    };
  }

  function makeDomMockSession(root: DomNodeLike) {
    return {
      send: async (method: string) => {
        if (method === 'DOM.getDocument') {
          return { root };
        }
        if (method === 'Page.getLayoutMetrics') {
          return {
            layoutViewport: { clientWidth: 1280, clientHeight: 800 },
          };
        }
        throw new Error(`Unhandled method: ${method}`);
      },
    };
  }

  it('renders a compact role tree and registers interactive elements with @ref', async () => {
    const nodes: AXNode[] = [
      {
        nodeId: '1',
        backendDOMNodeId: 10,
        role: { type: 'role', value: 'RootWebArea' },
        name: { type: 'computedString', value: 'Test App' },
        childIds: ['2', '3'],
      },
      {
        nodeId: '2',
        backendDOMNodeId: 20,
        parentId: '1',
        role: { type: 'role', value: 'heading' },
        name: { type: 'computedString', value: 'Welcome' },
      },
      {
        nodeId: '3',
        backendDOMNodeId: 30,
        parentId: '1',
        role: { type: 'role', value: 'button' },
        name: { type: 'computedString', value: 'Get Started' },
      },
    ];

    const session = makeAxMockSession(nodes);
    const snap = await captureSnapshot(profileId, session, { pageLabel });

    expect(snap.text).toContain('- RootWebArea "Test App"');
    expect(snap.text).toContain('- heading "Welcome"');
    expect(snap.text).toContain('- button "Get Started" [ref=');
    expect(snap.refs.length).toBeGreaterThan(0);
    expect(snap.refs[0].startsWith('@')).toBe(true);

    const resolved = resolveRef(profileId, pageLabel, snap.refs[0]);
    expect(resolved).not.toBeNull();
    expect(resolved?.backendNodeId).toBe(30);
  });

  it('replaces registry on full snapshot and retains registry on subtree snapshot', async () => {
    const nodesA: AXNode[] = [
      {
        nodeId: '1',
        backendDOMNodeId: 101,
        role: { type: 'role', value: 'button' },
        name: { type: 'computedString', value: 'Initial Button' },
      },
    ];
    const sessionA = makeAxMockSession(nodesA);
    const snapA = await captureSnapshot(profileId, sessionA, { scope: 'full_page', pageLabel });
    expect(snapA.refs).toHaveLength(1);
    expect(snapA.refs[0]).toBe('@1');

    const resolvedA = resolveRef(profileId, pageLabel, '@1');
    expect(resolvedA?.backendNodeId).toBe(101);

    // Subtree snapshot: should RETAIN @1 and assign @2
    const nodesSubtree: AXNode[] = [
      {
        nodeId: '1',
        backendDOMNodeId: 101,
        role: { type: 'role', value: 'generic' },
        childIds: ['2'],
      },
      {
        nodeId: '2',
        backendDOMNodeId: 102,
        parentId: '1',
        role: { type: 'role', value: 'button' },
        name: { type: 'computedString', value: 'Subtree Button' },
      },
    ];
    const sessionSubtree = makeAxMockSession(nodesSubtree);
    const snapSub = await captureSnapshot(profileId, sessionSubtree, {
      scope: 'subtree',
      root: '@1',
      pageLabel,
    });

    expect(snapSub.refs).toHaveLength(1);
    expect(snapSub.refs[0]).toBe('@2');

    // Both @1 and @2 must be in the registry now
    expect(resolveRef(profileId, pageLabel, '@1')?.backendNodeId).toBe(101);
    expect(resolveRef(profileId, pageLabel, '@2')?.backendNodeId).toBe(102);

    // Another full snapshot: must REPLACE all previous refs
    const nodesB: AXNode[] = [
      {
        nodeId: '1',
        backendDOMNodeId: 201,
        role: { type: 'role', value: 'button' },
        name: { type: 'computedString', value: 'New Button' },
      },
    ];
    const sessionB = makeAxMockSession(nodesB);
    const snapB = await captureSnapshot(profileId, sessionB, { scope: 'full_page', pageLabel });
    expect(snapB.refs).toEqual(['@1']);
    expect(resolveRef(profileId, pageLabel, '@1')?.backendNodeId).toBe(201);
    // @2 was replaced, should not exist
    expect(resolveRef(profileId, pageLabel, '@2')).toBeNull();
  });

  it('invalidates refs on navigation', async () => {
    const nodes: AXNode[] = [
      {
        nodeId: '1',
        backendDOMNodeId: 50,
        role: { type: 'role', value: 'button' },
        name: { type: 'computedString', value: 'Nav Button' },
      },
    ];
    const session = makeAxMockSession(nodes);
    const snap = await captureSnapshot(profileId, session, { pageLabel });
    expect(snap.refs).toHaveLength(1);
    expect(resolveRef(profileId, pageLabel, '@1')).not.toBeNull();

    // Specific pageLabel invalidation
    invalidateRefs(profileId, pageLabel);
    expect(resolveRef(profileId, pageLabel, '@1')).toBeNull();

    // Repopulate and test full profile invalidation
    await captureSnapshot(profileId, session, { pageLabel });
    expect(resolveRef(profileId, pageLabel, '@1')).not.toBeNull();

    invalidateRefs(profileId);
    expect(resolveRef(profileId, pageLabel, '@1')).toBeNull();
  });

  it('filters elements outside viewport in viewport scope', async () => {
    const nodes: AXNode[] = [
      {
        nodeId: '1',
        backendDOMNodeId: 10,
        role: { type: 'role', value: 'button' },
        name: { type: 'computedString', value: 'Visible' },
        bounds: { x: 50, y: 100, width: 200, height: 40 },
      },
      {
        nodeId: '2',
        backendDOMNodeId: 20,
        role: { type: 'role', value: 'button' },
        name: { type: 'computedString', value: 'Offscreen Below' },
        bounds: { x: 50, y: 1500, width: 200, height: 40 },
      },
    ];

    const session = makeAxMockSession(nodes);
    const vpSnap = await captureSnapshot(profileId, session, { scope: 'viewport', pageLabel });

    expect(vpSnap.text).toContain('Visible');
    expect(vpSnap.text).not.toContain('Offscreen Below');
    expect(vpSnap.refs).toHaveLength(1);

    // Full page scope includes both
    const fullSnap = await captureSnapshot(profileId, session, { scope: 'full_page', pageLabel });
    expect(fullSnap.text).toContain('Visible');
    expect(fullSnap.text).toContain('Offscreen Below');
    expect(fullSnap.refs).toHaveLength(2);
  });

  it('falls back to DOM tree when Accessibility.getFullAXTree is unavailable', async () => {
    const root: DomNodeLike = {
      nodeId: 1,
      backendNodeId: 10,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          nodeId: 2,
          backendNodeId: 20,
          nodeType: 1,
          nodeName: 'BUTTON',
          children: [
            {
              nodeId: 3,
              backendNodeId: 30,
              nodeType: 3,
              nodeValue: 'Fallback Button',
            },
          ],
        },
      ],
    };

    const session = makeDomMockSession(root);
    const snap = await captureSnapshot(profileId, session, { scope: 'full_page', pageLabel });

    expect(snap.text).toContain('- button "Fallback Button" [ref=1]');
    expect(snap.refs).toEqual(['@1']);
    expect(resolveRef(profileId, pageLabel, '@1')?.backendNodeId).toBe(20);
  });

  it('normalizes ref lookup across @N, ref=N, and bare N', () => {
    const nodes: AXNode[] = [
      {
        nodeId: '1',
        backendDOMNodeId: 777,
        role: { type: 'role', value: 'button' },
        name: { type: 'computedString', value: 'Test' },
      },
    ];
    const session = makeAxMockSession(nodes);

    return captureSnapshot(profileId, session, { pageLabel }).then(() => {
      expect(resolveRef(profileId, pageLabel, '@1')?.backendNodeId).toBe(777);
      expect(resolveRef(profileId, pageLabel, 'ref=1')?.backendNodeId).toBe(777);
      expect(resolveRef(profileId, pageLabel, '1')?.backendNodeId).toBe(777);
    });
  });
});
