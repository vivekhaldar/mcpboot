// ABOUTME: Fetches URLs referenced in prompts and extracts usable text content.
// ABOUTME: Handles HTML stripping, GitHub URL rewriting, URL discovery, and content truncation.

import { warn, verbose } from "./log.js";
import type { FetchedContent } from "./types.js";

const URL_REGEX = /(https?:\/\/[^\s"'<>)\]]+)/g;
const GITHUB_REPO_REGEX =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/;
const MAX_CONTENT_LENGTH = 100_000;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Extract all URLs from prompt text. Deduplicates results.
 */
export function extractUrls(prompt: string): string[] {
  const matches = prompt.match(URL_REGEX);
  if (!matches) return [];
  // Clean trailing punctuation that's part of prose, not the URL
  const cleaned = matches.map((url) => url.replace(/[.,;:!?)]+$/, ""));
  return [...new Set(cleaned)];
}

/**
 * Rewrite a GitHub repository URL to fetch the raw README.
 * Returns null if the URL is not a GitHub repo root.
 */
export function rewriteGitHubUrl(url: string): string | null {
  const match = url.match(GITHUB_REPO_REGEX);
  if (!match) return null;
  const [, owner, repo] = match;
  return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`;
}

/**
 * Strip HTML tags and extract readable text content.
 * Removes script, style, nav, header, and footer elements first.
 */
export function stripHtml(html: string): string {
  let text = html;
  // Remove elements whose content should be discarded
  text = text.replace(
    /<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );
  // Replace remaining tags with spaces (preserves word boundaries between elements)
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

/**
 * Discover URLs within content text. Deduplicates results.
 */
export function discoverUrls(content: string): string[] {
  return extractUrls(content);
}

/**
 * Truncate content to a maximum length.
 */
export function truncateContent(
  content: string,
  limit: number = MAX_CONTENT_LENGTH,
): string {
  if (content.length <= limit) return content;
  return content.slice(0, limit);
}

/**
 * Fetch a single URL and return processed content.
 * Handles GitHub URL rewriting, HTML stripping, and content truncation.
 */
export async function fetchUrl(url: string): Promise<FetchedContent> {
  const fetchTarget = rewriteGitHubUrl(url) ?? url;

  verbose(`Fetching ${fetchTarget}`);

  const response = await fetch(fetchTarget, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": "mcpboot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Fetch failed for ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const rawContentType = response.headers.get("content-type") ?? "text/plain";
  // Normalize content type (strip charset and parameters)
  const contentType = rawContentType.split(";")[0].trim();

  let text = await response.text();

  // Strip HTML if needed
  if (contentType === "text/html") {
    text = stripHtml(text);
  }

  // Truncate
  text = truncateContent(text);

  // Discover URLs in the content
  const discovered = discoverUrls(text);

  return {
    url,
    content: text,
    contentType,
    discoveredUrls: discovered,
  };
}

/**
 * Fetch multiple URLs in parallel, skipping failures.
 * Returns only successful results.
 */
export async function fetchUrls(urls: string[]): Promise<FetchedContent[]> {
  if (urls.length === 0) return [];

  const results = await Promise.allSettled(urls.map((url) => fetchUrl(url)));
  const contents: FetchedContent[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      contents.push(result.value);
    } else {
      warn(`Failed to fetch URL: ${result.reason}`);
    }
  }

  return contents;
}
