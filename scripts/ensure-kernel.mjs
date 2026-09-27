// Ensures the fingerprint-chromium kernel exists on disk before packaging or dev run.
// Aligned with src/main/util/kernelAcquire.ts — verifies SHA256 digest before extraction.
// Usage: node scripts/ensure-kernel.mjs (also runs automatically via `predist` / dev)
import { existsSync, mkdirSync, createWriteStream, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { createRequire } from 'node:module';

// The compiled locator, so this script and the app cannot disagree about where a kernel lives.
const require = createRequire(import.meta.url);
const { findKernelExecutable } = require('../dist/src/main/util/kernelLayout.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The pinned kernel, per platform — mirroring `src/main/util/kernelAcquire.ts`. Windows was the only
// platform this script served; it named the Windows ZIP, extracted into a Windows-shaped directory
// and then looked for `chrome.exe`, so on macOS and Linux it either downloaded the wrong binary or
// failed the final check. The asset and the payload paths now follow the HOST, and the executable is
// located with the same module the app uses — so a manual install lands where the app looks for it.
const KERNEL_VERSION = '148.0.7778.215';
const PINNED = {
  win32: {
    asset: `ungoogled-chromium_${KERNEL_VERSION}-1.1_windows_x64.zip`,
    sha256: '9ef3f471b7a6641b4224532522b29141ce3746e27d55788d88e2fd951f362579',
  },
  linux: {
    asset: `ungoogled-chromium-${KERNEL_VERSION}-1-x86_64.AppImage`,
    sha256: 'a5fa5e6c05cb7fa3617ec2ca642ad3cc6e586ac5249cc29edb0a602d695685f0',
  },
  darwin: {
    asset: `ungoogled-chromium_${KERNEL_VERSION}-1.1_macos.dmg`,
    sha256: 'b72f091e2e1a7583eed389c4b8e3534ed355e568af8c8bbf8fc30a25e23ca679',
  },
};
const SPEC = PINNED[process.platform];
if (!SPEC) throw new Error(`[ensure-kernel] no pinned kernel for ${process.platform}`);

const ASSET_NAME = SPEC.asset;
const EXPECTED_SHA256 = SPEC.sha256;
const KERNEL_DIR = path.join(__dirname, '..', 'data', 'chromium', 'fingerprint-chromium');

const URL = `https://github.com/adryfish/fingerprint-chromium/releases/download/${KERNEL_VERSION}/${ASSET_NAME}`;

async function main() {
  if (findKernelExecutable(KERNEL_DIR)) {
    console.log(`[ensure-kernel] fingerprint-chromium ${KERNEL_VERSION} already present: ${KERNEL_DIR}`);
    return;
  }
  console.log(`[ensure-kernel] fingerprint-chromium ${KERNEL_VERSION} not found, downloading...`);
  console.log(`[ensure-kernel] GET ${URL}`);
  mkdirSync(KERNEL_DIR, { recursive: true });
  const tmpZip = path.join(KERNEL_DIR, `kernel-${KERNEL_VERSION}-${Date.now()}.zip.tmp`);

  try {
    const res = await fetch(URL, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);

    const hash = crypto.createHash('sha256');
    const writeStream = createWriteStream(tmpZip);

    const reader = res.body.getReader ? res.body.getReader() : null;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        writeStream.write(value);
      }
      writeStream.end();
      await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
    } else {
      await new Promise((resolve, reject) => {
        res.body.on('data', (chunk) => {
          hash.update(chunk);
          writeStream.write(chunk);
        });
        res.body.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', resolve);
        res.body.on('end', () => writeStream.end());
      });
    }

    const actualSha256 = hash.digest('hex').toLowerCase();
    if (actualSha256 !== EXPECTED_SHA256.toLowerCase()) {
      try { unlinkSync(tmpZip); } catch { /* ignore */ }
      throw new Error(`digest mismatch for ${ASSET_NAME}: expected ${EXPECTED_SHA256}, got ${actualSha256}`);
    }

    console.log('[ensure-kernel] SHA256 verified successfully. Extracting...');

    // Extraction is implemented for the ZIP payload only. Saying so explicitly matters: without this
    // guard a macOS or Linux run would hand a `.dmg`/`.AppImage` to AdmZip and fail with an opaque
    // archive error. Both formats need a real toolchain step (hdiutil, or a chmod on the AppImage)
    // that the APP already implements in `util/kernelAcquire.ts` — this script exists for offline
    // packaging, and claiming support it does not have would be worse than declining.
    if (process.platform !== 'win32') {
      throw new Error(
        `[ensure-kernel] automatic extraction is implemented for the Windows ZIP only. ` +
          `On ${process.platform} the kernel is installed by the app itself ` +
          `(Settings -> Browser Kernel), or place ${ASSET_NAME} under ${KERNEL_DIR} manually.`
      );
    }

    const zip = new AdmZip(tmpZip);
    zip.extractAllTo(KERNEL_DIR, true);

    try { unlinkSync(tmpZip); } catch { /* ignore */ }

    const installed = findKernelExecutable(KERNEL_DIR);
    if (!installed) throw new Error(`kernel extracted but no executable found under ${KERNEL_DIR}`);
    console.log(`[ensure-kernel] OK: ${installed}`);
  } catch (err) {
    try {
      if (existsSync(tmpZip)) unlinkSync(tmpZip);
    } catch { /* ignore */ }
    throw err;
  }
}

main().catch((err) => {
  console.error('[ensure-kernel] FAILED:', err.message);
  process.exit(1);
});
