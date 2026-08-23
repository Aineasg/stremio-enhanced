/**
 * Sanitization & validation helpers shared across the app.
 *
 * Why this file exists
 * --------------------
 * The app loads remote content (Stremio web, GitHub API, plugin/theme
 * registry, plugin-supplied strings, …) and interpolates much of that
 * data into either HTML strings or file paths.  Without sanitization
 * every one of those paths is an XSS / path-traversal / SSRF vector.
 *
 * The helpers below are intentionally small and dependency-free so they
 * can be used both from the main process and the renderer.
 */

import { join, normalize, sep, isAbsolute } from "path";
import { pathToFileURL } from "url";

/* ------------------------------------------------------------------ *
 * HTML / attribute sanitization                                       *
 * ------------------------------------------------------------------ */

const HTML_ENTITY_MAP: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "/": "&#47;",
};

/**
 * Escape a string for safe insertion into an HTML text node or into a
 * double-quoted attribute value.  This is the minimum viable defense
 * against XSS when building HTML by hand.
 */
export function escapeHtml(input: unknown): string {
    if (input === null || input === undefined) return "";
    return String(input).replace(/[&<>"'/]/g, (ch) => HTML_ENTITY_MAP[ch] ?? ch);
}

/**
 * Escape a string for use inside a JavaScript single-quoted string
 * literal.  Used when we MUST interpolate untrusted data into a
 * generated <script> block (e.g. the plugin loader wrapper).
 */
export function escapeJsString(input: unknown): string {
    if (input === null || input === undefined) return "";
    return String(input)
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/`/g, "\\`")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029")
        .replace(/<\/(script)>/gi, "<\\/$1>");
}

/* ------------------------------------------------------------------ *
 * File-name / file-path validation                                    *
 * ------------------------------------------------------------------ */

/**
 * Whitelist of characters allowed inside a plugin / theme / config
 * file name.  Anything containing path separators, NUL bytes, leading
 * dots, shell metacharacters, or windows drive letters is rejected.
 */
const SAFE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-]*$/;

/**
 * Return true iff `name` is a "leaf-only" file name – i.e. a name that
 * contains no path separators, no parent-directory segments, and no
 * other suspicious characters.  Use this to gate every IPC handler that
 * receives a plugin / theme / config file name from the renderer.
 */
export function isSafeFileName(name: unknown): name is string {
    if (typeof name !== "string" || name.length === 0 || name.length > 255) return false;
    if (name.includes("\0")) return false;
    if (name === "." || name === "..") return false;
    if (name.startsWith(".")) return false; // disallow hidden / dotfiles
    if (/[/\\]/.test(name)) return false; // no path separators
    if (/[<>:"|?*]/.test(name)) return false; // windows-reserved
    if (name.length > 4 && /^[A-Za-z]:/.test(name)) return false; // drive letter
    return SAFE_FILENAME_RE.test(name);
}

/**
 * Resolve `name` (an untrusted leaf file name) inside the trusted
 * `baseDir`.  Throws if `name` would escape `baseDir` or contains
 * anything other than a safe file name.
 *
 * The returned path is guaranteed (post-normalization) to live inside
 * `baseDir`.
 */
export function safeJoin(baseDir: string, name: string): string {
    if (!isSafeFileName(name)) {
        throw new Error(`Unsafe file name rejected: ${JSON.stringify(name)}`);
    }
    const candidate = normalize(join(baseDir, name));
    const normalizedBase = normalize(baseDir);
    // Ensure the resulting path still lives under baseDir.
    const prefix = normalizedBase.endsWith(sep) ? normalizedBase : normalizedBase + sep;
    if (candidate !== normalizedBase && !candidate.startsWith(prefix)) {
        throw new Error(`Path traversal attempt rejected: ${JSON.stringify(name)}`);
    }
    return candidate;
}

/* ------------------------------------------------------------------ *
 * URL validation                                                       *
 * ------------------------------------------------------------------ */

/**
 * Allowed URL schemes for any externally-fetched plugin / theme / asset.
 * `javascript:`, `data:`, `file:`, etc. are explicitly forbidden.
 */
const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);

/**
 * Validate that `value` is a string URL using an allowed scheme and
 * (optionally) that its host matches the given allowlist.
 *
 * If `allowHosts` is supplied, the host (after lowercasing) must equal
 * or be a subdomain of one of the entries.
 */
export function isSafeUrl(value: unknown, allowHosts?: string[]): value is string {
    if (typeof value !== "string") return false;
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }
    const scheme = parsed.protocol.toLowerCase();
    if (!ALLOWED_URL_SCHEMES.has(scheme)) return false;
    // Block userinfo-based tricks like "https://evil@example.com"
    if (parsed.username || parsed.password) return false;
    // Block extremely long URLs (parsing/regex-DoS surface).
    if (value.length > 8192) return false;
    if (allowHosts && allowHosts.length > 0) {
        const host = parsed.hostname.toLowerCase();
        return allowHosts.some(
            (allowed) => host === allowed || host.endsWith("." + allowed)
        );
    }
    return true;
}

/** Convert a local absolute path to a `file://` URL safely. */
export function safeFileUrl(filePath: string): string {
    if (!isAbsolute(filePath)) {
        throw new Error("safeFileUrl requires an absolute path");
    }
    return pathToFileURL(filePath).toString();
}

/* ------------------------------------------------------------------ *
 * Private-network target blocking                                      *
 * ------------------------------------------------------------------ */

/**
 * True when the hostname is an IPv4 literal inside a reserved /
 * private / loopback / link-local range (RFC1918, CGNAT, APIPA,
 * loopback, 0/8) or an IPv6 literal that is loopback / ULA /
 * link-local / unspecified.
 */
function isPrivateIpLiteral(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

    // IPv4 literal
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        const parts = host.split(".").map(Number);
        if (parts.some((p) => p > 255)) return false; // not a valid literal - let URL rules decide
        const [a, b] = parts;
        if (a === 0 || a === 10 || a === 127) return true;            // 0/8, 10/8, loopback
        if (a === 169 && b === 254) return true;                      // link-local + cloud metadata
        if (a === 172 && b >= 16 && b <= 31) return true;             // 172.16/12
        if (a === 192 && b === 168) return true;                      // 192.168/16
        if (a === 100 && b >= 64 && b <= 127) return true;            // CGNAT 100.64/10
        if (a === 192 && b === 0) return true;                        // 192.0.0.0/24 & 192.0.2.0/24
        if (a === 198 && (b === 18 || b === 19)) return true;         // benchmarking
        return false;
    }

    // IPv6 literal
    if (host.includes(":")) {
        if (host === "::" || host === "::1") return true;
        if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;             // fc00::/7 ULA
        if (/^fe[89ab][0-9a-f]:/.test(host)) return true;             // fe80::/10 link-local
        // IPv4-mapped / NAT64 (::ffff:0:0/96, 64:ff9b::/96)
        if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateIpLiteral(host.slice(7));
        if (/^64:ff9b::/.test(host)) return true;
        return false;
    }

    return false;
}

/**
 * Stricter variant of isSafeUrl for URLs that the MAIN PROCESS is
 * asked to fetch on behalf of semi-trusted content (e.g. a plugin's
 * `updateUrl`).  A main-process fetch has no CORS restrictions, so
 * allowing arbitrary hosts would give a malicious plugin a proxy into
 * the user's local network and cloud metadata endpoints
 * (169.254.169.254 and friends).
 *
 * Blocks: non-http(s), userinfo, loopback / private / link-local IP
 * literals, `localhost` and friends, `.local` / `.internal` names,
 * and non-standard ports (only :80 and :443 allowed).
 *
 * Note: DNS-rebinding (a public name resolving to a private IP) is
 * out of scope for this check - hosts must still be considered
 * semi-trusted.
 */
export function isSafeFetchUrl(value: unknown, allowHosts?: string[]): value is string {
    if (!isSafeUrl(value, allowHosts)) return false;
    let parsed: URL;
    try {
        parsed = new URL(value as string);
    } catch {
        return false;
    }
    const host = parsed.hostname.toLowerCase();

    if (isPrivateIpLiteral(host)) return false;
    if (host === "localhost" || host.endsWith(".localhost")) return false;
    if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return false;
    if (host.endsWith(".localdomain")) return false;

    // Only standard http/https ports so a plugin can't probe
    // arbitrary internal services on exotic ports.
    if (parsed.port !== "" && parsed.port !== "80" && parsed.port !== "443") return false;

    return true;
}

/* ------------------------------------------------------------------ *
 * Generic helpers                                                      *
 * ------------------------------------------------------------------ */

/**
 * Coerce an unknown value to a string with a hard length cap.  Useful
 * for IPC inputs that should be small labels / titles.
 */
export function clampString(value: unknown, max = 1024): string {
    if (value === null || value === undefined) return "";
    const s = String(value);
    return s.length > max ? s.slice(0, max) : s;
}
