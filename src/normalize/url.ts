const TRACKING_PARAM = /^(?:utm_.*|gh_src|gclid|fbclid|msclkid|ref|source|lever-source(?:\[\])?|lever-origin|mc_[ce]id)$/i;

/** Conservative comparison URL. The original application link is always stored separately. */
export function canonicalizeUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.hash = "";
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}
