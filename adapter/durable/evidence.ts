import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Binding } from '../core.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function keyPair() {
  const keys = generateKeyPairSync('ed25519');
  return { privateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString() };
}
export interface EvidenceBody {
  version: 'agentbudget.simulator-evidence.v1';
  taskId: string; binding: Binding; challenge: string;
  status: 'unknown' | 'pending' | 'paid' | 'disabled';
  transaction: string | null;
}
export interface Evidence { body: EvidenceBody; signature: string }
export function attest(body: EvidenceBody, privateKey: string): Evidence {
  return { body, signature: sign(null, Buffer.from(canonical(body)), createPrivateKey(privateKey)).toString('base64') };
}
export function verifyEvidence(e: Evidence, publicKey: string, taskId: string, binding: Binding, challenge: string): EvidenceBody {
  if (!e?.body || typeof e.signature !== 'string' ||
      !verify(null, Buffer.from(canonical(e.body)), createPublicKey(publicKey), Buffer.from(e.signature, 'base64'))) throw new Error('invalid evidence signature');
  const b = e.body;
  if (b.version !== 'agentbudget.simulator-evidence.v1' || b.taskId !== taskId || b.challenge !== challenge || !isDeepStrictEqual(b.binding, binding)) throw new Error('evidence context/binding mismatch');
  if (!['unknown', 'pending', 'paid', 'disabled'].includes(b.status)) throw new Error('invalid evidence status');
  if (b.status === 'paid' ? b.transaction !== `sim:${binding.id}` : b.transaction !== null) throw new Error('invalid evidence transaction');
  return b;
}
export function fingerprint(text: string) { return createHash('sha256').update(text).digest('hex'); }
