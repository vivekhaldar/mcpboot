// ABOUTME: Domain whitelist construction and enforcement for the runtime sandbox.
// ABOUTME: Gates fetch calls to only whitelisted domains discovered from prompt URLs and fetched content.

import type { FetchedContent, Whitelist } from "./types.js";

/**
 * Extract the hostname from a URL string. Returns null for invalid URLs.
 */
export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Check if a hostname matches a whitelisted domain (exact or subdomain).
 * "api.example.com" matches whitelisted "example.com".
 * "example.com" does NOT match whitelisted "api.example.com".
 */
function domainMatches(hostname: string, whitelistedDomain: string): boolean {
  if (hostname === whitelistedDomain) return true;
  return hostname.endsWith("." + whitelistedDomain);
}

/**
 * Build a Whitelist from prompt URLs and fetched content.
 * Domains are collected from:
 * 1. All prompt URLs
 * 2. All discoveredUrls in fetched content
 */
export function buildWhitelist(
  promptUrls: string[],
  contents: FetchedContent[],
): Whitelist {
  const domains = new Set<string>();

  for (const url of promptUrls) {
    const domain = extractDomain(url);
    if (domain) domains.add(domain);
  }

  for (const content of contents) {
    for (const url of content.discoveredUrls) {
      const domain = extractDomain(url);
      if (domain) domains.add(domain);
    }
  }

  return {
    domains,
    allows(url: string): boolean {
      const hostname = extractDomain(url);
      if (!hostname) return false;
      for (const d of domains) {
        if (domainMatches(hostname, d)) return true;
      }
      return false;
    },
  };
}

/**
 * Create a fetch wrapper that only allows requests to whitelisted domains.
 * Throws a descriptive error for blocked domains.
 */
export function createWhitelistedFetch(
  whitelist: Whitelist,
  realFetch: (url: string) => Promise<Response> = globalThis.fetch,
): (url: string) => Promise<Response> {
  return (url: string): Promise<Response> => {
    const hostname = extractDomain(url);
    if (!hostname) {
      return Promise.reject(
        new Error(`Fetch blocked: invalid URL "${url}"`),
      );
    }
    if (!whitelist.allows(url)) {
      return Promise.reject(
        new Error(
          `Fetch blocked: domain "${hostname}" not in whitelist. Add it to your prompt to allow access.`,
        ),
      );
    }
    return realFetch(url);
  };
}
