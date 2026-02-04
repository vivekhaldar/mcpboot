// ABOUTME: Tests for URL extraction, fetching, HTML stripping, and content processing.
// ABOUTME: Covers extractUrls, GitHub URL rewriting, HTML cleanup, URL discovery, and truncation.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractUrls,
  rewriteGitHubUrl,
  stripHtml,
  discoverUrls,
  truncateContent,
  fetchUrl,
  fetchUrls,
} from "../../src/fetcher.js";

describe("extractUrls", () => {
  it("extracts a single URL from prompt text", () => {
    const urls = extractUrls("Create tools for https://api.example.com/docs");
    expect(urls).toEqual(["https://api.example.com/docs"]);
  });

  it("extracts multiple URLs", () => {
    const urls = extractUrls(
      "Use https://api.one.com and http://api.two.com/v2 for data",
    );
    expect(urls).toEqual([
      "https://api.one.com",
      "http://api.two.com/v2",
    ]);
  });

  it("returns empty array when no URLs are present", () => {
    expect(extractUrls("Create a calculator tool")).toEqual([]);
  });

  it("handles URLs with query strings and fragments", () => {
    const urls = extractUrls(
      "See https://example.com/api?key=val#section for details",
    );
    expect(urls).toEqual(["https://example.com/api?key=val#section"]);
  });

  it("handles URLs surrounded by quotes", () => {
    const urls = extractUrls('Check "https://example.com/api" for docs');
    expect(urls).toEqual(["https://example.com/api"]);
  });

  it("handles URLs surrounded by parentheses", () => {
    const urls = extractUrls("Docs (https://example.com/api) here");
    expect(urls).toEqual(["https://example.com/api"]);
  });

  it("handles URLs at end of sentence with period", () => {
    const urls = extractUrls("See https://example.com/api.");
    expect(urls).toEqual(["https://example.com/api"]);
  });

  it("deduplicates URLs", () => {
    const urls = extractUrls(
      "Use https://example.com and also https://example.com for data",
    );
    expect(urls).toEqual(["https://example.com"]);
  });
});

describe("rewriteGitHubUrl", () => {
  it("rewrites github.com repo URL to raw README", () => {
    expect(rewriteGitHubUrl("https://github.com/HackerNews/API")).toBe(
      "https://raw.githubusercontent.com/HackerNews/API/HEAD/README.md",
    );
  });

  it("rewrites with trailing slash", () => {
    expect(rewriteGitHubUrl("https://github.com/owner/repo/")).toBe(
      "https://raw.githubusercontent.com/owner/repo/HEAD/README.md",
    );
  });

  it("returns null for non-GitHub URLs", () => {
    expect(rewriteGitHubUrl("https://example.com/foo/bar")).toBeNull();
  });

  it("returns null for GitHub URLs that are not repo roots", () => {
    expect(
      rewriteGitHubUrl("https://github.com/owner/repo/blob/main/file.ts"),
    ).toBeNull();
  });

  it("returns null for GitHub user profile URLs", () => {
    expect(rewriteGitHubUrl("https://github.com/username")).toBeNull();
  });
});

describe("stripHtml", () => {
  it("removes HTML tags and returns text", () => {
    expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("removes script tags and their content", () => {
    expect(
      stripHtml('<p>Before</p><script>alert("xss")</script><p>After</p>'),
    ).toBe("Before After");
  });

  it("removes style tags and their content", () => {
    expect(
      stripHtml("<p>Text</p><style>body { color: red; }</style><p>More</p>"),
    ).toBe("Text More");
  });

  it("removes nav, header, and footer tags and their content", () => {
    expect(
      stripHtml(
        "<nav>Nav stuff</nav><main>Content</main><footer>Footer</footer>",
      ),
    ).toBe("Content");
  });

  it("collapses whitespace", () => {
    expect(stripHtml("<p>  Hello   world  </p>")).toBe("Hello world");
  });

  it("handles nested tags", () => {
    expect(stripHtml("<div><p><span>Deep</span></p></div>")).toBe("Deep");
  });

  it("decodes common HTML entities", () => {
    expect(stripHtml("&amp; &lt; &gt; &quot;")).toBe('& < > "');
  });
});

describe("discoverUrls", () => {
  it("finds URLs in plain text content", () => {
    const urls = discoverUrls(
      "The API is at https://api.example.com/v1 and docs at https://docs.example.com",
    );
    expect(urls).toContain("https://api.example.com/v1");
    expect(urls).toContain("https://docs.example.com");
  });

  it("returns empty array when no URLs found", () => {
    expect(discoverUrls("No URLs here")).toEqual([]);
  });

  it("deduplicates discovered URLs", () => {
    const urls = discoverUrls(
      "https://example.com and https://example.com again",
    );
    expect(urls).toEqual(["https://example.com"]);
  });
});

describe("truncateContent", () => {
  it("returns content unchanged when under limit", () => {
    expect(truncateContent("short", 100)).toBe("short");
  });

  it("truncates content that exceeds the limit", () => {
    const long = "a".repeat(200);
    const result = truncateContent(long, 100);
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it("uses default limit of 100000", () => {
    const content = "x".repeat(50000);
    expect(truncateContent(content)).toBe(content);
  });
});

describe("fetchUrl", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and returns text content", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name === "content-type" ? "text/plain" : null,
      },
      text: () => Promise.resolve("API documentation text"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchUrl("https://example.com/docs");
    expect(result.url).toBe("https://example.com/docs");
    expect(result.content).toBe("API documentation text");
    expect(result.contentType).toBe("text/plain");
  });

  it("strips HTML for text/html content", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name === "content-type" ? "text/html; charset=utf-8" : null,
      },
      text: () =>
        Promise.resolve("<html><body><p>Hello</p></body></html>"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchUrl("https://example.com/page");
    expect(result.content).toBe("Hello");
    expect(result.contentType).toBe("text/html");
  });

  it("rewrites GitHub repo URLs", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name === "content-type" ? "text/plain" : null,
      },
      text: () => Promise.resolve("# Hacker News API\nDocumentation here"),
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchUrl("https://github.com/HackerNews/API");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/HackerNews/API/HEAD/README.md",
      expect.any(Object),
    );
  });

  it("stores JSON content as-is", async () => {
    const json = '{"openapi": "3.0.0", "paths": {}}';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name === "content-type" ? "application/json" : null,
      },
      text: () => Promise.resolve(json),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchUrl("https://example.com/api.json");
    expect(result.content).toBe(json);
    expect(result.contentType).toBe("application/json");
  });

  it("throws on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(fetchUrl("https://example.com/missing")).rejects.toThrow(
      /404/,
    );
  });

  it("truncates content exceeding the limit", async () => {
    const longContent = "x".repeat(200_000);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name === "content-type" ? "text/plain" : null,
      },
      text: () => Promise.resolve(longContent),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchUrl("https://example.com/big");
    expect(result.content.length).toBeLessThanOrEqual(100_000);
  });

  it("discovers URLs within fetched content", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name === "content-type" ? "text/plain" : null,
      },
      text: () =>
        Promise.resolve(
          "Base URL: https://api.example.com/v1\nDocs: https://docs.example.com",
        ),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchUrl("https://example.com/readme");
    expect(result.discoveredUrls).toContain("https://api.example.com/v1");
    expect(result.discoveredUrls).toContain("https://docs.example.com");
  });
});

describe("fetchUrls", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches multiple URLs in parallel", async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "text/plain" : null,
        },
        text: () => Promise.resolve(`Content from ${url}`),
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchUrls([
      "https://a.example.com",
      "https://b.example.com",
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("Content from https://a.example.com");
    expect(result[1].content).toBe("Content from https://b.example.com");
  });

  it("returns empty array for empty input", async () => {
    expect(await fetchUrls([])).toEqual([]);
  });

  it("skips failed fetches and returns successful ones", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("Network error"));
      }
      return Promise.resolve({
        ok: true,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "text/plain" : null,
        },
        text: () => Promise.resolve("Success"),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchUrls([
      "https://fail.example.com",
      "https://ok.example.com",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Success");
  });
});
