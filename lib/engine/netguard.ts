// Stops a blueprint from reaching private networks when the runner is exposed
// to the internet. Every outbound URL (and every redirect hop) must use http(s)
// and resolve only to public addresses: no loopback, private ranges,
// link-local (which covers cloud metadata at 169.254.169.254), CGNAT,
// multicast or reserved space.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class BlockedUrlError extends Error {}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

function isBlockedV6(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (a === '::' || a === '::1') return true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms
  const mapped = a.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
  const first = parseInt(a.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (a.startsWith('2001:db8')) return true; // documentation
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip.replace(/^\[|\]$/g, ''));
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true;
}

/** Throws BlockedUrlError unless the URL is http(s) and resolves only to public addresses. */
export async function assertPublicUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError(`Invalid URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new BlockedUrlError(`Only http and https URLs are allowed (got ${u.protocol})`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new BlockedUrlError(`Requests to ${host} are blocked on this runner`);
  }
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new BlockedUrlError(`Requests to private or reserved addresses are blocked on this runner (${host})`);
  }
}
