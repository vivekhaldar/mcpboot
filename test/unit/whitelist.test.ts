// ABOUTME: Unit tests for domain whitelist construction and enforcement.
// ABOUTME: Tests domain extraction, subdomain matching, and whitelisted fetch proxy.

import { describe, it, expect, vi } from "vitest";
import {
  extractDomain,
  buildWhitelist,
  createWhitelistedFetch,
} from "../../src/whitelist.js";
import type { FetchedContent } from "../../src/types.js";

describe("extractDomain", () => {
  it("extracts domain from a simple URL", () => {
    expect(extractDomain("https://example.com/path")).toBe("example.com");
  });

  it("extracts domain from URL with port", () => {
    expect(extractDomain("https://example.com:8080/path")).toBe("example.com");
  });

  it("extracts domain from URL with subdomain", () => {
    expect(extractDomain("https://api.example.com/v1/items")).toBe(
      "api.example.com",
    );
  });

  it("returns null for invalid URL", () => {
    expect(extractDomain("not-a-url")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractDomain("")).toBeNull();
  });
});

describe("buildWhitelist", () => {
  it("builds whitelist from prompt URLs", () => {
    const wl = buildWhitelist(
      ["https://api.example.com/docs", "https://other.org/api"],
      [],
    );
    expect(wl.domains.has("api.example.com")).toBe(true);
    expect(wl.domains.has("other.org")).toBe(true);
  });

  it("includes domains from fetched content discovered URLs", () => {
    const content: FetchedContent = {
      url: "https://docs.example.com",
      content: "some content",
      contentType: "text/html",
      discoveredUrls: [
        "https://api.example.com/v1",
        "https://cdn.example.com/assets",
      ],
    };
    const wl = buildWhitelist(["https://docs.example.com"], [content]);
    expect(wl.domains.has("docs.example.com")).toBe(true);
    expect(wl.domains.has("api.example.com")).toBe(true);
    expect(wl.domains.has("cdn.example.com")).toBe(true);
  });

  it("deduplicates domains", () => {
    const wl = buildWhitelist(
      ["https://example.com/a", "https://example.com/b"],
      [],
    );
    expect(wl.domains.size).toBe(1);
    expect(wl.domains.has("example.com")).toBe(true);
  });

  it("skips invalid URLs without crashing", () => {
    const wl = buildWhitelist(
      ["https://example.com", "not-a-url", "https://other.com"],
      [],
    );
    expect(wl.domains.size).toBe(2);
  });

  it("returns empty whitelist for no URLs", () => {
    const wl = buildWhitelist([], []);
    expect(wl.domains.size).toBe(0);
  });
});

describe("Whitelist.allows", () => {
  it("allows exact domain match", () => {
    const wl = buildWhitelist(["https://api.example.com"], []);
    expect(wl.allows("https://api.example.com/v1/items")).toBe(true);
  });

  it("allows subdomain when parent domain is whitelisted", () => {
    const wl = buildWhitelist(["https://example.com"], []);
    expect(wl.allows("https://api.example.com/v1")).toBe(true);
  });

  it("does NOT allow parent domain when only subdomain is whitelisted", () => {
    const wl = buildWhitelist(["https://api.example.com"], []);
    expect(wl.allows("https://example.com/page")).toBe(false);
  });

  it("blocks unlisted domains", () => {
    const wl = buildWhitelist(["https://example.com"], []);
    expect(wl.allows("https://evil.com/steal")).toBe(false);
  });

  it("returns false for invalid URL", () => {
    const wl = buildWhitelist(["https://example.com"], []);
    expect(wl.allows("not-a-url")).toBe(false);
  });

  it("handles deeply nested subdomains", () => {
    const wl = buildWhitelist(["https://example.com"], []);
    expect(wl.allows("https://a.b.c.example.com/path")).toBe(true);
  });

  it("does not match partial domain names", () => {
    const wl = buildWhitelist(["https://example.com"], []);
    // "notexample.com" should NOT match "example.com"
    expect(wl.allows("https://notexample.com")).toBe(false);
  });
});

describe("createWhitelistedFetch", () => {
  it("delegates to real fetch for allowed domains", async () => {
    const wl = buildWhitelist(["https://api.example.com"], []);
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const wlFetch = createWhitelistedFetch(wl, mockFetch);

    await wlFetch("https://api.example.com/v1/items");

    expect(mockFetch).toHaveBeenCalledWith("https://api.example.com/v1/items");
  });

  it("throws for blocked domains with descriptive error", async () => {
    const wl = buildWhitelist(["https://example.com"], []);
    const mockFetch = vi.fn();
    const wlFetch = createWhitelistedFetch(wl, mockFetch);

    await expect(wlFetch("https://evil.com/steal")).rejects.toThrow(
      /evil\.com/,
    );
    await expect(wlFetch("https://evil.com/steal")).rejects.toThrow(
      /not in whitelist/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws for invalid URLs", async () => {
    const wl = buildWhitelist(["https://example.com"], []);
    const mockFetch = vi.fn();
    const wlFetch = createWhitelistedFetch(wl, mockFetch);

    await expect(wlFetch("not-a-url")).rejects.toThrow();
  });

  it("allows subdomain fetch when parent is whitelisted", async () => {
    const wl = buildWhitelist(["https://example.com"], []);
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const wlFetch = createWhitelistedFetch(wl, mockFetch);

    await wlFetch("https://api.example.com/v1");
    expect(mockFetch).toHaveBeenCalledWith("https://api.example.com/v1");
  });
});
