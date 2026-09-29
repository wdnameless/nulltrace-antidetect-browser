#!/usr/bin/env node
/**
 * CLI tool to generate and issue signed licenses for the app.
 *
 * Usage:
 *   node scripts/make-license.mjs --email dev@example.com --exp 2026-12-31
 *   node scripts/make-license.mjs --perpetual --email alice@example.com
 *   node scripts/make-license.mjs --key <path|pem> --plan pro --days 30 --email client@corp.com
 *   node scripts/make-license.mjs --key <path|pem> --plan pro --perpetual --email client@corp.com
 *   node scripts/make-license.mjs new
 *   node scripts/make-license.mjs rotate
 *
 * Env:
 *   LICENSE_PRIVATE_KEY      — PKCS#8 PEM of the Ed25519 private key (highest priority).
 *   LICENSE_PRIVATE_KEY_PATH — Path to file containing PKCS#8 PEM of the private key.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const LEAKED_PUBLIC_KEY_PEM_SPKI =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAVxFPPO9Q0RRZZUYacTrT5OnBwit7GcyTpYR/ijc+tsA=\n-----END PUBLIC KEY-----\n';

function b64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const cmd = process.argv[2];
if (process.argv.includes('--help') || process.argv.includes('-h') || cmd === 'help') {
  console.log(`Usage:
  node scripts/make-license.mjs --email dev@example.com --exp 2026-12-31
  node scripts/make-license.mjs --perpetual --email alice@example.com
  node scripts/make-license.mjs --key <path|pem> --plan pro --days 30 --email client@corp.com
  node scripts/make-license.mjs --key <path|pem> --plan pro --perpetual --email client@corp.com
  node scripts/make-license.mjs new
  node scripts/make-license.mjs rotate

Env:
  LICENSE_PRIVATE_KEY      — PKCS#8 PEM of the Ed25519 private key (highest priority).
  LICENSE_PRIVATE_KEY_PATH — Path to file containing PKCS#8 PEM of the private key.`);
  process.exit(0);
}

if (cmd === 'new') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const fp = createHash('sha256').update(pubPem).digest('hex').slice(0, 16);
  console.log('Generated fresh Ed25519 keypair:');
  console.log(`Public Key Fingerprint: ${fp}\n`);
  console.log('Public Key (resources/license-public-key.pem):\n' + pubPem);
  console.log('Private Key (KEEP SECRET, NEVER COMMIT):\n' + privPem);
  process.exit(0);
}

if (cmd === 'rotate') {
  const pemPath = path.join(rootDir, 'resources', 'license-public-key.pem');
  if (!fs.existsSync(pemPath)) {
    console.error(`Error: ${pemPath} not found`);
    process.exit(1);
  }
  const raw = fs.readFileSync(pemPath, 'utf8');
  const fp = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  const leakedFp = createHash('sha256').update(LEAKED_PUBLIC_KEY_PEM_SPKI).digest('hex').slice(0, 16);

  if (fp === leakedFp || raw.includes('MCowBQYDK2VwAyEAVxFPPO9Q0RRZZUYacTrT5OnBwit7GcyTpYR/ijc+tsA=')) {
    console.error(`Refusing to operate: resources/license-public-key.pem still matches the leaked dev key (fp ${fp}).`);
    console.error('Run node scripts/make-license.mjs new and save the public key first.');
    process.exit(1);
  }

  console.log(`Active public key fingerprint: ${fp}`);
  console.log('Pinned key is rotated away from leaked key. OK.');
  process.exit(0);
}

const args = process.argv.slice(2);
const isPerpetual = args.includes('--perpetual');
const emailIdx = args.indexOf('--email');
const email = emailIdx >= 0 ? args[emailIdx + 1] : args[0]?.includes('@') ? args[0] : undefined;

const planIdx = args.indexOf('--plan');
if (planIdx >= 0) {
  const planVal = args[planIdx + 1];
  if (planVal !== 'pro') {
    console.error(`Error: invalid plan "${planVal}" (expected "pro")`);
    process.exit(1);
  }
}

const expIdx = args.indexOf('--exp');
const expArg = expIdx >= 0 ? args[expIdx + 1] : (!args[0]?.startsWith('--') && !args[1]?.startsWith('--') ? args[1] : undefined);
const daysIdx = args.indexOf('--days');

if (daysIdx >= 0 && (expIdx >= 0 || isPerpetual || expArg !== undefined)) {
  console.error('Error: --days cannot be used together with --exp or --perpetual');
  process.exit(1);
}

let exp;
if (daysIdx >= 0) {
  const daysVal = Number(args[daysIdx + 1]);
  if (!Number.isFinite(daysVal) || daysVal <= 0) {
    console.error('Error: invalid --days value (expected positive number)');
    process.exit(1);
  }
  exp = Math.floor(Date.now() / 1000) + Math.floor(daysVal * 86400);
} else if (!isPerpetual && expArg) {
  const d = new Date(expArg);
  if (isNaN(d.getTime())) {
    console.error('Error: invalid expiry date format (expected YYYY-MM-DD)');
    process.exit(1);
  }
  exp = Math.floor(d.getTime() / 1000);
}

const keyIdx = args.indexOf('--key');
let privKey;
if (keyIdx >= 0) {
  const keyArg = args[keyIdx + 1];
  if (!keyArg) {
    console.error('Error: --key requires a path or PEM argument');
    process.exit(1);
  }
  if (fs.existsSync(keyArg)) {
    privKey = fs.readFileSync(keyArg, 'utf8');
  } else {
    privKey = keyArg;
  }
} else if (process.env.LICENSE_PRIVATE_KEY) {
  privKey = process.env.LICENSE_PRIVATE_KEY;
} else if (process.env.LICENSE_PRIVATE_KEY_PATH) {
  if (!fs.existsSync(process.env.LICENSE_PRIVATE_KEY_PATH)) {
    console.error(`Error: file specified in LICENSE_PRIVATE_KEY_PATH does not exist: ${process.env.LICENSE_PRIVATE_KEY_PATH}`);
    process.exit(1);
  }
  privKey = fs.readFileSync(process.env.LICENSE_PRIVATE_KEY_PATH, 'utf8');
}

if (!privKey) {
  console.error('Error: LICENSE_PRIVATE_KEY, LICENSE_PRIVATE_KEY_PATH environment variable, or --key is required');
  process.exit(1);
}

const payload = { plan: 'pro', ...(exp !== undefined && { exp }), ...(email && { email }) };
const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
const sig = sign(null, payloadBuf, privKey);
const token = `${b64urlEncode(payloadBuf)}.${b64urlEncode(sig)}`;
console.log(token);