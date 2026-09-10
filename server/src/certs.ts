import { promises as fs } from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { generate } from 'selfsigned';

export interface CertPair {
  cert: string;
  key: string;
}

const CERT_FILE = 'cert.pem';
const KEY_FILE = 'key.pem';

/** Days before expiry at which a stored cert is regenerated instead of used. */
const RENEW_WITHIN_DAYS = 30;

async function readPair(certsDir: string): Promise<CertPair | null> {
  try {
    const [cert, key] = await Promise.all([
      fs.readFile(path.join(certsDir, CERT_FILE), 'utf8'),
      fs.readFile(path.join(certsDir, KEY_FILE), 'utf8'),
    ]);
    if (!cert.includes('BEGIN CERTIFICATE') || !key.includes('PRIVATE KEY')) return null;
    // A mismatched pair must not crash https.createServer with an opaque
    // OpenSSL error later; an expiring one must not hard-fail day 366 for
    // users who trusted it. Either way: regenerate cleanly.
    try {
      createSecureContext({ cert, key });
    } catch {
      return null;
    }
    try {
      const validTo = new X509Certificate(cert).validTo;
      const renewAfter = Date.now() + RENEW_WITHIN_DAYS * 24 * 60 * 60 * 1000;
      if (Number.isNaN(Date.parse(validTo)) || Date.parse(validTo) <= renewAfter) return null;
    } catch {
      return null;
    }
    return { cert, key };
  } catch {
    return null;
  }
}

/**
 * Loads the dev certificate from <certsDir>/{cert,key}.pem, generating a
 * 365-day self-signed one (CN=localhost, SANs localhost/127.0.0.1) on first
 * run. Generation is synchronous inside node-forge and takes ~0.5s.
 */
export async function ensureCerts(certsDir: string): Promise<CertPair> {
  await fs.mkdir(certsDir, { recursive: true });
  const existing = await readPair(certsDir);
  if (existing) return existing;

  const pems = generate([{ name: 'commonName', value: 'localhost' }], {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' }, // dNSName
          { type: 7, ip: '127.0.0.1' }, // iPAddress
        ],
      },
    ],
  });

  const certPath = path.join(certsDir, CERT_FILE);
  const keyPath = path.join(certsDir, KEY_FILE);
  await fs.writeFile(certPath, pems.cert, 'utf8');
  await fs.writeFile(keyPath, pems.private, 'utf8');
  // Best-effort lockdown of the private key; chmod is a no-op on Windows.
  try {
    await fs.chmod(keyPath, 0o600);
  } catch {
    /* best-effort */
  }
  return { cert: pems.cert, key: pems.private };
}
