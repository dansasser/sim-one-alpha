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

/**
 * Generate a new ULID string (Crockford base32, 26 chars: 48-bit ms timestamp +
 * 80-bit randomness).
 *
 * The random suffix is ALWAYS drawn from `crypto.randomBytes` rather than a
 * process-local monotonic counter. A deterministic counter starts at 0 in
 * every Node process, so two processes generating ULIDs within the same
 * millisecond would collide (process A counter=0..N, process B counter=0..N).
 * Pure 80-bit crypto randomness is process-independent and collision-proof for
 * practical ID volumes, matching the ULID spec's random-component intent.
 */
export function ulid(): string {
  const now = Date.now();
  return encodeTime(now, 10) + encodeRandom(16);
}
