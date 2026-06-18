import { randomBytes } from 'node:crypto';

/**
 * Minimal ULID generator (Crockford base32, 26 chars: 48-bit ms timestamp +
 * 80-bit randomness). No external dependency (Dependency Rules). Matches the
 * format the Rust `parse_ulid` validator accepts.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number, length: number): string {
  let value = ms;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const mod = value % 32;
    out = CROCKFORD[mod] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(bytes: number): string {
  const buf = randomBytes(bytes);
  let out = '';
  for (let i = 0; i < bytes; i += 1) {
    out += CROCKFORD[buf[i] & 31];
  }
  return out;
}

/** Generate a new ULID string. */
export function ulid(): string {
  return encodeTime(Date.now(), 10) + encodeRandom(16);
}
