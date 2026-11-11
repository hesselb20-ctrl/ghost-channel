// The object that the fountain code carries: a small self-describing container
// around the user's URL, text or file.
//
//   byte 0      payload type (0 text, 1 url, 2 file)
//   bytes 1-3   data length, big endian (max 16 MiB, UI caps at 64 KiB)
//   byte 4      name length  (file only, else 0)
//   byte 5      mime length  (file only, else 0)
//   ...         name, mime, data
//   last 4      CRC-32 of everything before it
//
// The trailing CRC is the end-to-end check: a decoded object is only shown to
// the user if it matches.

import { crc32 } from './crc32.ts';

export type PayloadType = 'text' | 'url' | 'file';
const TYPE_CODES: PayloadType[] = ['text', 'url', 'file'];

export const MAX_PAYLOAD_BYTES = 64 * 1024;

export interface Payload {
  type: PayloadType;
  data: Uint8Array;
  name?: string;
  mime?: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });

export function textPayload(text: string): Payload {
  return { type: 'text', data: enc.encode(text) };
}
export function urlPayload(url: string): Payload {
  return { type: 'url', data: enc.encode(url) };
}
export function payloadText(p: Payload): string {
  return dec.decode(p.data);
}

export function packContainer(p: Payload): Uint8Array {
  const name = p.type === 'file' ? enc.encode(p.name ?? 'file').subarray(0, 255) : new Uint8Array(0);
  const mime = p.type === 'file' ? enc.encode(p.mime ?? 'application/octet-stream').subarray(0, 255) : new Uint8Array(0);
  if (p.data.length > 0xffffff) throw new Error('payload too large');
  const total = 6 + name.length + mime.length + p.data.length + 4;
  const out = new Uint8Array(total);
  out[0] = TYPE_CODES.indexOf(p.type);
  out[1] = (p.data.length >>> 16) & 0xff;
  out[2] = (p.data.length >>> 8) & 0xff;
  out[3] = p.data.length & 0xff;
  out[4] = name.length;
  out[5] = mime.length;
  let o = 6;
  out.set(name, o);
  o += name.length;
  out.set(mime, o);
  o += mime.length;
  out.set(p.data, o);
  o += p.data.length;
  const c = crc32(out, 0, o);
  out[o] = c >>> 24;
  out[o + 1] = (c >>> 16) & 0xff;
  out[o + 2] = (c >>> 8) & 0xff;
  out[o + 3] = c & 0xff;
  return out;
}

/** `bytes` may carry trailing zero padding from the fountain block grid. */
export function unpackContainer(bytes: Uint8Array): Payload | null {
  if (bytes.length < 10) return null;
  const type = TYPE_CODES[bytes[0]];
  if (!type) return null;
  const len = (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  const nameLen = bytes[4];
  const mimeLen = bytes[5];
  const end = 6 + nameLen + mimeLen + len;
  if (end + 4 > bytes.length) return null;
  const want = ((bytes[end] << 24) | (bytes[end + 1] << 16) | (bytes[end + 2] << 8) | bytes[end + 3]) >>> 0;
  if (crc32(bytes, 0, end) !== want) return null;
  const p: Payload = { type, data: bytes.slice(6 + nameLen + mimeLen, end) };
  if (type === 'file') {
    p.name = dec.decode(bytes.subarray(6, 6 + nameLen));
    p.mime = dec.decode(bytes.subarray(6 + nameLen, 6 + nameLen + mimeLen));
  }
  return p;
}
