import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CACHE_DIR = join(homedir(), ".pi", "web_cache");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB
const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = "pi-coding-agent/1.0";

// --- HTML to plain text conversion ---

function stripHtml(html: string): string {
  let text = html;

  // Remove script and style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Convert block-level tags to newlines
  const blockTags =
    /(<\/?(div|p|br|hr|h[1-6]|li|ul|ol|table|tr|td|th|blockquote|pre|section|article|header|footer|nav|main|aside|figure|figcaption|details|summary)[^>]*>)/gi;
  text = text.replace(blockTags, "\n");

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");

  // Decode numeric entities
  text = text.replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(parseInt(code, 10))
  );
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );

  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

// --- File-based cache ---

function cacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function cacheGet(url: string): string | null {
  try {
    const file = join(CACHE_DIR, cacheKey(url));
    const stat = statSync(file);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

function cacheSet(url: string, content: string): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, cacheKey(url)), content, "utf-8");
  } catch {
    // Silently ignore cache write failures
  }
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  // ---- web_search ----
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using the Brave Search API. Returns titles, URLs, and snippets for matching results. Includes knowledge panel/infobox when available.",
    promptSnippet:
      "Search the web for current information, documentation, or examples",
    promptGuidelines: [
      "Use web_search to find relevant URLs, then web_fetch to read specific pages.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      num_results: Type.Optional(
        Type.Number({
          description: "Number of results (default 5, max 10)",
          minimum: 1,
          maximum: 10,
        })
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const apiKey = process.env.BRAVE_SEARCH_API_KEY;
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "Error: BRAVE_SEARCH_API_KEY environment variable is not set.\n\nTo use web_search:\n1. Sign up at https://brave.com/search/api/ (free tier: 2,000 queries/month)\n2. Set BRAVE_SEARCH_API_KEY in your environment\n3. Restart pi",
            },
          ],
          isError: true,
          details: {},
        };
      }

      const count = Math.min(params.num_results ?? 5, 10);
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", params.query);
      url.searchParams.set("count", String(count));

      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
        signal,
      });

      if (!response.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Brave Search API error: ${response.status} ${response.statusText}`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      const data = (await response.json()) as any;
      const lines: string[] = [];

      // Knowledge panel / infobox
      const infobox =
        data.infobox ?? data.knowledge_panel ?? data.knowledge_graph;
      if (infobox) {
        lines.push("## Knowledge Panel");
        if (infobox.title) lines.push(`**${infobox.title}**`);
        if (infobox.description)
          lines.push(infobox.description.replace(/<[^>]+>/g, ""));
        if (infobox.url) lines.push(`URL: ${infobox.url}`);
        lines.push("");
      }

      // Web results
      const results = data.web?.results ?? [];
      if (results.length === 0 && lines.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No results found for: ${params.query}`,
            },
          ],
          details: {},
        };
      }

      lines.push(`## Search Results for: ${params.query}\n`);
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        lines.push(`${i + 1}. **${r.title ?? "Untitled"}**`);
        lines.push(`   URL: ${r.url}`);
        if (r.description) {
          lines.push(
            `   ${r.description.replace(/<[^>]+>/g, "")}`
          );
        }
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    },
  });

  // ---- web_fetch ----
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a web page and return its content as plain text. Strips HTML tags, scripts, and styles. Handles text/* and application/json content types. Results are cached for 1 hour.",
    promptSnippet: "Fetch and read the contents of a web page as plain text",
    promptGuidelines: [
      "Use web_search to find relevant URLs, then web_fetch to read specific pages.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
    }),

    async execute(_toolCallId, params, signal) {
      const { url } = params;

      // Check cache first
      const cached = cacheGet(url);
      if (cached !== null) {
        return {
          content: [{ type: "text", text: cached }],
          details: { cached: true },
        };
      }

      // Fetch with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      // Combine external signal with our timeout
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort);

      try {
        const response = await fetch(url, {
          headers: { "User-Agent": USER_AGENT },
          signal: controller.signal,
          redirect: "follow",
        });

        clearTimeout(timeout);

        if (!response.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Fetch error: ${response.status} ${response.statusText} for ${url}`,
              },
            ],
            isError: true,
            details: {},
          };
        }

        const contentType = response.headers.get("content-type") ?? "";
        const isText =
          contentType.startsWith("text/") ||
          contentType.includes("application/json");

        if (!isText) {
          return {
            content: [
              {
                type: "text",
                text: `Cannot read binary content (${contentType}) from ${url}`,
              },
            ],
            isError: true,
            details: {},
          };
        }

        let body = await response.text();

        // Convert HTML to plain text
        if (
          contentType.includes("text/html") ||
          contentType.includes("text/xhtml")
        ) {
          body = stripHtml(body);
        }

        // Truncate
        if (Buffer.byteLength(body, "utf-8") > MAX_OUTPUT_BYTES) {
          body =
            body.slice(0, MAX_OUTPUT_BYTES) +
            "\n\n[Content truncated at 50KB]";
        }

        // Cache the result
        cacheSet(url, body);

        return {
          content: [{ type: "text", text: body }],
          details: { cached: false, contentType },
        };
      } catch (err: any) {
        clearTimeout(timeout);
        const message =
          err.name === "AbortError"
            ? `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s for ${url}`
            : `Fetch failed for ${url}: ${err.message}`;
        return {
          content: [{ type: "text", text: message }],
          isError: true,
          details: {},
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  });
}
