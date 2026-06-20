// Client-side encryption (AES-GCM 256). File content and names are encrypted in
// the browser before being written to the CRDT, so the sync server — and anyone
// who connects directly to the document — only ever sees ciphertext. Only our app
// holds the key material and can decrypt.
//
// The key is derived (PBKDF2) from an app secret + the room name, so different
// drives get different keys. The app secret lives in the bundle: it gates access
// to "via our website". For a stronger zero-knowledge model, move the secret into
// the URL fragment (#key=…) so it never reaches the bundle or the server.
import { bytesToB64, b64ToBytes } from './util.js'

const APP_SECRET = 'crdt-drive::v1::Yk7m2pQ9'  // rotate to invalidate all existing data
const te = new TextEncoder()
const td = new TextDecoder()
const keyCache = new Map()

export async function deriveKey(room) {
  if (keyCache.has(room)) return keyCache.get(room)
  const base = await crypto.subtle.importKey('raw', te.encode(APP_SECRET), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: te.encode('crdt-drive/' + room), iterations: 100_000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  keyCache.set(room, key)
  return key
}

// returns Uint8Array  iv(12) || ciphertext
export async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv); out.set(ct, 12)
  return out
}
export async function decryptBytes(key, packed) {
  const iv = packed.subarray(0, 12), ct = packed.subarray(12)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct))
}

// string <-> base64(ciphertext) for metadata fields
export async function encryptToB64(key, str) { return bytesToB64(await encryptBytes(key, te.encode(str))) }
export async function decryptFromB64(key, b64) { return td.decode(await decryptBytes(key, b64ToBytes(b64))) }
