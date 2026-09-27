// Kernel update checker (v0.2.20): compares the installed fingerprint-chromium
// version against the latest upstream GitHub release. Read-only — downloading
// and installing a new kernel stays a manual, deliberate step (ROADMAP risk:
// "зафиксировать версию ядра, обновлять осознанно").
import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import { kernelBaseDirs } from '../config';
import { readKernelVersionMarker } from './kernelLayout';

const UPSTREAM_API = 'https://api.github.com/repos/adryfish/fingerprint-chromium/releases/latest';

/** Extract the installed kernel version (e.g. "148.0.7778.215"), or null when there is none. */
export function getInstalledKernelVersion(): string | null {
  // A packaged build keeps the kernel under resources/kernel, not the data dir, so
  // checking only the data dir reported "not installed" for a working packaged app.
  for (const base of kernelBaseDirs()) {
    // The marker first: it is the only source that works on EVERY platform. A version in a
    // directory name happens to exist on Windows (the payload dir carries it) and on Linux (the
    // AppImage file name carries it), but the macOS build directory is `Chromium.app` — no version
    // anywhere. Without the marker a macOS install was reported as absent, so the UI offered a
    // 134 MB download of a kernel already on disk.
    const marked = readKernelVersionMarker(base);
    if (marked) return marked;

    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        // Files too, not only directories: on Linux the kernel IS a file (an AppImage) whose name
        // holds the version, and the original `!entry.isDirectory() → continue` skipped it.
        const m = entry.name.match(/(\d+\.\d+\.\d+\.\d+)/);
        if (m) return m[1];
        if (entry.isDirectory()) {
          const nested = readKernelVersionMarker(path.join(base, entry.name));
          if (nested) return nested;
        }
      }
    } catch {
      // kernel dir missing here — try the next candidate
    }
  }
  return null;
}

export interface KernelUpdateInfo {
  installed: string | null;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl?: string;
  checkedAt: number;
  error?: string;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function checkKernelUpdate(): Promise<KernelUpdateInfo> {
  const installed = getInstalledKernelVersion();
  try {
    const res = await fetch(UPSTREAM_API, {
      headers: { 'User-Agent': 'antidetect-browser', Accept: 'application/vnd.github+json' },
      timeout: 15000,
    });
    const body = (await res.json()) as { tag_name?: string; name?: string; html_url?: string };
    const tag = body.tag_name ?? body.name ?? '';
    const m = tag.match(/(\d+\.\d+\.\d+\.\d+)/);
    const latest = m ? m[1] : tag || null;
    return {
      installed,
      latest,
      updateAvailable: Boolean(installed && latest && compareVersions(latest, installed) > 0),
      releaseUrl: body.html_url,
      checkedAt: Date.now(),
    };
  } catch (err) {
    return { installed, latest: null, updateAvailable: false, checkedAt: Date.now(), error: (err as Error).message };
  }
}
