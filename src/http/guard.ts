import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";

export class BlockedDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedDestinationError";
  }
}

const blocked = new BlockList();
blocked.addSubnet("0.0.0.0", 8, "ipv4");
blocked.addSubnet("10.0.0.0", 8, "ipv4");
blocked.addSubnet("100.64.0.0", 10, "ipv4");
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4"); // Includes the cloud metadata address.
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.0.0.0", 24, "ipv4");
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addSubnet("198.18.0.0", 15, "ipv4");
blocked.addSubnet("224.0.0.0", 4, "ipv4");
blocked.addSubnet("240.0.0.0", 4, "ipv4");
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("ff00::", 8, "ipv6");

export function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const candidate = mapped?.[1] ?? address;
  const family = isIP(candidate);
  if (family === 0) return true;
  return blocked.check(candidate, family === 4 ? "ipv4" : "ipv6");
}

/** Rejects URLs that can never be crawled. Resolved addresses are checked by guardedLookup. */
export function assertAllowedUrl(url: URL): void {
  if (url.protocol !== "https:") throw new BlockedDestinationError(`Refusing ${url.protocol} URL`);
  if (url.username || url.password) throw new BlockedDestinationError("Refusing URL with credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new BlockedDestinationError(`Refusing host ${host}`);
  }
  if (isIP(host) && isBlockedAddress(host)) throw new BlockedDestinationError(`Refusing address ${host}`);
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type Resolver = (hostname: string, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

const systemResolver: Resolver = (hostname, callback) => dnsLookup(hostname, { all: true }, callback);

/**
 * A socket-level DNS lookup that refuses restricted addresses. Checking here,
 * rather than before the request, closes the gap where a hostname re-resolves
 * to a private address between validation and connection.
 */
export function createGuardedLookup(resolve: Resolver = systemResolver) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolve(hostname, (error, addresses) => {
      if (error) {
        callback(error, "", 0);
        return;
      }
      const rejected = addresses.find((entry) => isBlockedAddress(entry.address));
      if (rejected || addresses.length === 0) {
        callback(new BlockedDestinationError(`${hostname} resolves to a restricted address`), "", 0);
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}
