import { describe, it, expect } from 'vitest';
import { parseBounds, parseUiXml, readUiHierarchy } from '../../src/main/android/uiHierarchy';

describe('Android UI hierarchy (R3: text-driven automation)', () => {
  describe('parseBounds', () => {
    it('parses a normal rect', () => {
      expect(parseBounds('[10,20][110,220]')).toEqual({ x: 10, y: 20, w: 100, h: 200 });
    });

    it('normalises inverted corners instead of emitting a negative width', () => {
      // Measured live on this image: uiautomator returned [21,2362][509,1397].
      expect(parseBounds('[21,2362][509,1397]')).toEqual({ x: 21, y: 1397, w: 488, h: 965 });
    });

    it('returns null for a missing or malformed bounds attribute', () => {
      expect(parseBounds('')).toBeNull();
      expect(parseBounds('nonsense')).toBeNull();
    });
  });

  describe('parseUiXml', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" clickable="false" bounds="[0,0][1080,2400]">
    <node index="0" text="Create account" resource-id="com.google.android.gms:id/create" class="android.widget.Button" clickable="true" enabled="true" focused="false" bounds="[40,2100][1040,2200]" />
    <node index="1" text="" content-desc="Next" resource-id="" class="android.widget.ImageButton" clickable="true" enabled="true" focused="true" bounds="[900,2000][1040,2140]" />
    <node index="2" text="Disabled" resource-id="" class="android.widget.Button" clickable="true" enabled="false" focused="false" bounds="[40,100][200,200]" />
  </node>
</hierarchy>`;

    it('keeps actionable nodes and drops empty scaffolding', () => {
      const nodes = parseUiXml(xml);
      // The root FrameLayout has no text/desc/id and is not clickable: scaffolding.
      expect(nodes).toHaveLength(3);
      expect(nodes.every((n) => n.className !== 'android.widget.FrameLayout')).toBe(true);
    });

    it('extracts the fields a clicker needs', () => {
      const nodes = parseUiXml(xml);
      const create = nodes.find((n) => n.text === 'Create account');
      expect(create).toMatchObject({
        resourceId: 'com.google.android.gms:id/create',
        clickable: true,
        enabled: true,
        bounds: { x: 40, y: 2100, w: 1000, h: 100 },
      });
      const next = nodes.find((n) => n.contentDesc === 'Next');
      expect(next?.focused).toBe(true);
      expect(nodes.find((n) => n.text === 'Disabled')?.enabled).toBe(false);
    });

    it('decodes XML entities in text and descriptions', () => {
      const nodes = parseUiXml(
        '<hierarchy><node text="Sign in &amp; sync" content-desc="a &lt;b&gt;" clickable="true" bounds="[0,0][10,10]"/></hierarchy>',
      );
      expect(nodes[0].text).toBe('Sign in & sync');
      expect(nodes[0].contentDesc).toBe('a <b>');
    });

    it('returns an empty list for a document with no nodes', () => {
      expect(parseUiXml('<hierarchy></hierarchy>')).toEqual([]);
    });
  });

  describe('readUiHierarchy', () => {
    it('deletes the previous dump first, then reports a fresh tree', async () => {
      // The cache is the actual bug: without the rm, uiautomator answers from the old file.
      const calls: string[][] = [];
      const adb = {
        shellCode: async (args: string[]) => {
          calls.push(args);
          if (args[0] === 'cat') {
            return {
              stdout: '<hierarchy><node text="OK" clickable="true" bounds="[0,0][10,10]"/></hierarchy>',
              stderr: '',
              exitCode: 0,
            };
          }
          return { stdout: 'UI hierchary dumped to: /sdcard/nulltrace-ui.xml', stderr: '', exitCode: 0 };
        },
      };
      const snap = await readUiHierarchy(adb);
      expect(calls[0][0]).toBe('rm');
      expect(calls.some((c) => c[0] === 'uiautomator')).toBe(true);
      expect(snap.fresh).toBe(true);
      expect(snap.nodes).toHaveLength(1);
      expect(snap.nodes[0].text).toBe('OK');
    });

    it('reports an error instead of an empty-but-fresh tree when the dump fails', async () => {
      const adb = {
        shellCode: async (args: string[]) => {
          if (args[0] === 'cat') return { stdout: '', stderr: 'No such file', exitCode: 1 };
          return { stdout: '', stderr: 'uiautomator: not found', exitCode: 1 };
        },
      };
      const snap = await readUiHierarchy(adb);
      expect(snap.fresh).toBe(false);
      expect(snap.error).toBeTruthy();
      expect(snap.nodes).toEqual([]);
    });
  });
});
