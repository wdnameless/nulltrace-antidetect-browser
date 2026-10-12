import { describe, it, expect, beforeEach } from 'vitest';
import { parseSelector, resolveSelector } from '../../../src/main/automation/selectors';
import { invalidateRefs, captureSnapshot, type DomNodeLike } from '../../../src/main/automation/snapshot';

describe('selectors — parseSelector grammar (tasks.md §1.1, interfaces.md §A)', () => {
  it('parses @ref syntax', () => {
    expect(parseSelector('@21')).toEqual({
      type: 'ref',
      value: '21',
      raw: '@21',
    });
    expect(parseSelector('@1')).toEqual({
      type: 'ref',
      value: '1',
      raw: '@1',
    });
    expect(parseSelector('@btn_next')).toEqual({
      type: 'ref',
      value: 'btn_next',
      raw: '@btn_next',
    });
  });

  it('parses ref= syntax', () => {
    expect(parseSelector('ref=21')).toEqual({
      type: 'ref',
      value: '21',
      raw: 'ref=21',
    });
    expect(parseSelector('ref=105')).toEqual({
      type: 'ref',
      value: '105',
      raw: 'ref=105',
    });
  });

  it('parses text= substring syntax', () => {
    expect(parseSelector('text=Submit')).toEqual({
      type: 'text',
      value: 'Submit',
      exact: false,
      raw: 'text=Submit',
    });
    expect(parseSelector('text=Click here to login')).toEqual({
      type: 'text',
      value: 'Click here to login',
      exact: false,
      raw: 'text=Click here to login',
    });
  });

  it('parses text="…" exact syntax', () => {
    expect(parseSelector('text="Sign in"')).toEqual({
      type: 'text',
      value: 'Sign in',
      exact: true,
      raw: 'text="Sign in"',
    });
    expect(parseSelector("text='Exact button'")).toEqual({
      type: 'text',
      value: 'Exact button',
      exact: true,
      raw: "text='Exact button'",
    });
  });

  it('parses loc=css: syntax', () => {
    expect(parseSelector('loc=css:button.primary')).toEqual({
      type: 'css',
      value: 'button.primary',
      raw: 'loc=css:button.primary',
    });
    expect(parseSelector('loc=css:#app > form input[name="user"]')).toEqual({
      type: 'css',
      value: '#app > form input[name="user"]',
      raw: 'loc=css:#app > form input[name="user"]',
    });
  });

  it('parses loc=role: syntax with optional name', () => {
    expect(parseSelector('loc=role:button')).toEqual({
      type: 'role',
      value: 'button',
      role: 'button',
      name: undefined,
      raw: 'loc=role:button',
    });
    expect(parseSelector('loc=role:button[name="Save"]')).toEqual({
      type: 'role',
      value: 'button[name="Save"]',
      role: 'button',
      name: 'Save',
      raw: 'loc=role:button[name="Save"]',
    });
    expect(parseSelector("loc=role:link[name='Home']")).toEqual({
      type: 'role',
      value: "link[name='Home']",
      role: 'link',
      name: 'Home',
      raw: "loc=role:link[name='Home']",
    });
  });

  it('parses loc=href: syntax', () => {
    expect(parseSelector('loc=href:/dashboard')).toEqual({
      type: 'href',
      value: '/dashboard',
      raw: 'loc=href:/dashboard',
    });
  });

  it('parses xpath= syntax', () => {
    expect(parseSelector("xpath=//button[@id='save']")).toEqual({
      type: 'xpath',
      value: "//button[@id='save']",
      raw: "xpath=//button[@id='save']",
    });
  });

  it('parses raw CSS syntax', () => {
    expect(parseSelector('button.primary')).toEqual({
      type: 'css',
      value: 'button.primary',
      raw: 'button.primary',
    });
    expect(parseSelector('#login-form > div.row input')).toEqual({
      type: 'css',
      value: '#login-form > div.row input',
      raw: '#login-form > div.row input',
    });
    expect(parseSelector('a[href^="https://"]')).toEqual({
      type: 'css',
      value: 'a[href^="https://"]',
      raw: 'a[href^="https://"]',
    });
  });

  describe('throws on invalid selectors', () => {
    const invalidSelectors = [
      '',
      '   ',
      '@',
      '@123#invalid',
      'ref=',
      'text=',
      'text="unclosed',
      "text='unclosed",
      'loc=',
      'loc=css:',
      'loc=role:',
      'loc=href:',
      'loc=unknown:test',
      'xpath=',
      'div[unclosed',
      'div(:)',
      '123',
      'button,',
      'div >',
    ];

    for (const sel of invalidSelectors) {
      it(`throws for "${sel}"`, () => {
        expect(() => parseSelector(sel)).toThrow();
      });
    }
  });
});

describe('selectors — resolveSelector (tasks.md §1.1, interfaces.md §A)', () => {
  const profileId = 'test_prof_1';
  const pageLabel = 'p1';

  beforeEach(() => {
    invalidateRefs(profileId);
  });

  function makeMockSession(root: DomNodeLike) {
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
        return {};
      },
    };
  }

  it('resolves @ref through registry', async () => {
    const root: DomNodeLike = {
      nodeId: 1,
      backendNodeId: 10,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          nodeId: 2,
          backendNodeId: 101,
          nodeType: 1,
          nodeName: 'BUTTON',
          attributes: ['class', 'btn'],
          children: [{ nodeId: 3, backendNodeId: 102, nodeType: 3, nodeValue: 'Submit' }],
        },
      ],
    };

    const session = makeMockSession(root);
    const snap = await captureSnapshot(profileId, session, { pageLabel });
    expect(snap.refs.length).toBeGreaterThan(0);
    const firstRef = snap.refs[0];

    const resolved = await resolveSelector(session, firstRef, profileId, pageLabel);
    expect(resolved.backendNodeId).toBe(101);
    expect(resolved.frameId).toBe('main_frame');
  });

  it('throws error when ref is not in registry', async () => {
    const session = makeMockSession({
      nodeId: 1,
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
    });

    await expect(resolveSelector(session, '@999', profileId, pageLabel)).rejects.toThrow(
      /not found in registry/i
    );
  });

  it('resolves exactly-one matching element', async () => {
    const root: DomNodeLike = {
      nodeId: 1,
      backendNodeId: 10,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          nodeId: 2,
          backendNodeId: 101,
          nodeType: 1,
          nodeName: 'BUTTON',
          attributes: ['id', 'unique-btn'],
        },
      ],
    };
    const session = makeMockSession(root);

    const resolved = await resolveSelector(session, '#unique-btn', profileId, pageLabel);
    expect(resolved.backendNodeId).toBe(101);
    expect(resolved.nodeId).toBe(2);
  });

  it('throws ambiguity error when selector matches multiple elements in top document', async () => {
    const root: DomNodeLike = {
      nodeId: 1,
      backendNodeId: 10,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          nodeId: 2,
          backendNodeId: 101,
          nodeType: 1,
          nodeName: 'BUTTON',
          attributes: ['class', 'btn'],
        },
        {
          nodeId: 3,
          backendNodeId: 102,
          nodeType: 1,
          nodeName: 'BUTTON',
          attributes: ['class', 'btn'],
        },
      ],
    };
    const session = makeMockSession(root);

    await expect(resolveSelector(session, 'button.btn', profileId, pageLabel)).rejects.toThrow(
      /ambiguous selector/i
    );
  });

  it('throws not found error when selector matches zero elements', async () => {
    const root: DomNodeLike = {
      nodeId: 1,
      backendNodeId: 10,
      nodeType: 9,
      nodeName: '#document',
      children: [],
    };
    const session = makeMockSession(root);

    await expect(resolveSelector(session, '#does-not-exist', profileId, pageLabel)).rejects.toThrow(
      /matched no elements/i
    );
  });

  it('prioritizes top-document match over frame match without ambiguity error', async () => {
    const root: DomNodeLike = {
      nodeId: 1,
      backendNodeId: 10,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          nodeId: 2,
          backendNodeId: 101,
          nodeType: 1,
          nodeName: 'BUTTON',
          attributes: ['id', 'action-btn'],
        },
        {
          nodeId: 4,
          backendNodeId: 103,
          nodeType: 1,
          nodeName: 'IFRAME',
          contentDocument: {
            nodeId: 5,
            backendNodeId: 104,
            nodeType: 9,
            nodeName: '#document',
            frameId: 'iframe_1',
            children: [
              {
                nodeId: 6,
                backendNodeId: 105,
                nodeType: 1,
                nodeName: 'BUTTON',
                attributes: ['id', 'action-btn'],
              },
            ],
          },
        },
      ],
    };
    const session = makeMockSession(root);

    // Top document has exactly 1 match -> should resolve top document without checking iframe
    const resolved = await resolveSelector(session, '#action-btn', profileId, pageLabel);
    expect(resolved.backendNodeId).toBe(101);
    expect(resolved.frameId).toBe('main_frame');
  });

  it('searches child frames when top document has no match', async () => {
    const root: DomNodeLike = {
      nodeId: 1,
      backendNodeId: 10,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          nodeId: 2,
          backendNodeId: 101,
          nodeType: 1,
          nodeName: 'IFRAME',
          contentDocument: {
            nodeId: 3,
            backendNodeId: 102,
            nodeType: 9,
            nodeName: '#document',
            frameId: 'iframe_auth',
            children: [
              {
                nodeId: 4,
                backendNodeId: 103,
                nodeType: 1,
                nodeName: 'BUTTON',
                attributes: ['id', 'frame-btn'],
              },
            ],
          },
        },
      ],
    };
    const session = makeMockSession(root);

    const resolved = await resolveSelector(session, '#frame-btn', profileId, pageLabel);
    expect(resolved.backendNodeId).toBe(103);
    expect(resolved.frameId).toBe('iframe_auth');
  });

  it('traverses open shadow roots', async () => {
    const root: DomNodeLike = {
      nodeId: 1,
      backendNodeId: 10,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          nodeId: 2,
          backendNodeId: 101,
          nodeType: 1,
          nodeName: 'CUSTOM-ELEMENT',
          shadowRoots: [
            {
              nodeId: 3,
              backendNodeId: 102,
              nodeType: 11,
              nodeName: '#document-fragment',
              shadowRootType: 'open',
              children: [
                {
                  nodeId: 4,
                  backendNodeId: 103,
                  nodeType: 1,
                  nodeName: 'BUTTON',
                  attributes: ['class', 'shadow-btn'],
                },
              ],
            },
          ],
        },
      ],
    };
    const session = makeMockSession(root);

    const resolved = await resolveSelector(session, 'button.shadow-btn', profileId, pageLabel);
    expect(resolved.backendNodeId).toBe(103);
  });

  it('resolves text, role, href, and xpath selectors', async () => {
    const root: DomNodeLike = {
      nodeId: 1,
      backendNodeId: 10,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          nodeId: 2,
          backendNodeId: 101,
          nodeType: 1,
          nodeName: 'BUTTON',
          children: [{ nodeId: 3, backendNodeId: 102, nodeType: 3, nodeValue: 'Save Changes' }],
        },
        {
          nodeId: 4,
          backendNodeId: 103,
          nodeType: 1,
          nodeName: 'A',
          attributes: ['href', '/settings/profile', 'aria-label', 'Profile Link'],
        },
        {
          nodeId: 5,
          backendNodeId: 104,
          nodeType: 1,
          nodeName: 'INPUT',
          attributes: ['type', 'text', 'id', 'username-field'],
        },
      ],
    };
    const session = makeMockSession(root);

    const textMatch = await resolveSelector(session, 'text=Save Changes', profileId, pageLabel);
    expect(textMatch.backendNodeId).toBe(101);

    const roleMatch = await resolveSelector(session, 'loc=role:textbox', profileId, pageLabel);
    expect(roleMatch.backendNodeId).toBe(104);

    const hrefMatch = await resolveSelector(session, 'loc=href:/settings/profile', profileId, pageLabel);
    expect(hrefMatch.backendNodeId).toBe(103);

    const xpathMatch = await resolveSelector(session, "xpath=//input[@id='username-field']", profileId, pageLabel);
    expect(xpathMatch.backendNodeId).toBe(104);
  });
});
