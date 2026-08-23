import { fork, execSync, execFile } from "child_process";
import * as unzipper from "unzipper";
import { createWriteStream, existsSync, mkdirSync, chmodSync, unlinkSync, readFileSync, writeFileSync, renameSync, rmSync } from "fs";
import { join, resolve, isAbsolute, relative } from "path";
import { getLogger } from "./logger";
import Properties from "../core/Properties";
import https from "https";
import { shell } from "electron";
import { FFMPEG_URLS, MACOS_FFPROBE_URLS } from "../constants";
import Helpers from "./Helpers";

const execFileAsync = (cmd: string, args: string[]) =>
    new Promise<void>((resolvePromise, reject) => {
        execFile(cmd, args, (err) => {
            if (err) reject(err); else resolvePromise();
        });
    });

// Hardening limits for all downloads: a redirect loop must not hang
// the app and a hijacked / oversized response must not fill the disk.
const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB hard ceiling for ffmpeg archives

class StreamingServer {
    private static logger = getLogger("StreamingServer");
    public static latestServerJsUrl: string = "";

    // Use config directory instead of executable directory for cross-platform compatibility (especially AppImage)
    private static streamingServerDir = join(Properties.enhancedPath, "streamingserver");
    private static serverScriptPath = join(this.streamingServerDir, "server.js");
    private static logFilePath = join(Properties.enhancedPath, "stremio-server.log");

    private static getFFmpegUrl(): string {
        const platform =
            process.platform === "win32" || process.platform === "darwin"
                ? process.platform
                : "linux";

        if (process.arch !== "x64" && process.arch !== "arm64") throw new Error(`Unsupported architecture: ${process.arch}`);

        return FFMPEG_URLS[platform][process.arch];
    }

    private static getMacOSFFprobeUrl(): string {
        if (process.arch !== "x64" && process.arch !== "arm64") throw new Error(`Unsupported architecture: ${process.arch}`);
        return MACOS_FFPROBE_URLS[process.arch];
    }

    // Get the directory where server.js should be placed
    public static getStreamingServerDir(): string {
        return this.streamingServerDir;
    }

    // Check if server.js exists
    public static serverJsExists(): boolean {
        return existsSync(this.serverScriptPath);
    }

    // Open the streaming server directory in the file manager
    public static openStreamingServerDir(): void {
        if (!existsSync(this.streamingServerDir)) {
            mkdirSync(this.streamingServerDir, { recursive: true });
        }
        shell.openPath(this.streamingServerDir);
    }

    // Check if system ffmpeg/ffprobe are available and working
    private static getSystemBinaryPath(binary: string): string | null {
        // SECURITY: `binary` is hardcoded by us ("ffmpeg" or "ffprobe")
        // so there's no command-injection surface here, but we still
        // harden it so future callers can't accidentally pass untrusted
        // values.
        if (!/^[a-zA-Z0-9_-]+$/.test(binary)) {
            this.logger.error(`Refusing to look up system binary with invalid name: ${binary}`);
            return null;
        }
        try {
            const result = execSync(`which ${binary}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
            const path = result.trim();
            if (path && existsSync(path)) {
                this.logger.info(`Found system ${binary} at: ${path}`);
                return path;
            }
        } catch {
            // which command failed, binary not found
        }
        return null;
    }

    // Get the best available ffmpeg path (prefer system, fallback to downloaded)
    private static getFFmpegPath(): string {
        // First, try system ffmpeg
        const systemFFmpeg = this.getSystemBinaryPath("ffmpeg");
        if (systemFFmpeg) {
            return systemFFmpeg;
        }

        // Fall back to downloaded version
        const downloadedPath = process.platform == "win32"
            ? join(this.streamingServerDir, "ffmpeg.exe")
            : join(this.streamingServerDir, "ffmpeg");
        return downloadedPath;
    }

    // Get the best available ffprobe path (prefer system, fallback to downloaded)
    private static getFFprobePath(): string {
        // First, try system ffprobe
        const systemFFprobe = this.getSystemBinaryPath("ffprobe");
        if (systemFFprobe) {
            return systemFFprobe;
        }

        // Fall back to downloaded version
        const downloadedPath = process.platform == "win32"
            ? join(this.streamingServerDir, "ffprobe.exe")
            : join(this.streamingServerDir, "ffprobe");
        return downloadedPath;
    }

    private static async downloadFile(url: string, dest: string): Promise<void> {
        return new Promise((resolve, reject) => {
            let redirects = 0;
            let bytesWritten = 0;
            let settled = false;

            const fail = (err: Error) => {
                if (settled) return;
                settled = true;
                // Remove a partial download so a truncated archive is
                // never mistaken for a complete one later.
                try { unlinkSync(dest); } catch { /* nothing to clean up */ }
                reject(err);
            };

            const file = createWriteStream(dest);
            file.on("error", fail);

            const request = (downloadUrl: string) => {
                let parsedUrl: URL;
                try {
                    parsedUrl = new URL(downloadUrl);
                } catch (err) {
                    fail(err as Error);
                    return;
                }
                // SECURITY: never follow a redirect that downgrades to a
                // non-https scheme (https.get would throw anyway, but be
                // explicit about it).
                if (parsedUrl.protocol !== "https:") {
                    fail(new Error(`Refusing non-https download URL: ${downloadUrl}`));
                    return;
                }

                https.get(downloadUrl, { headers: { "User-Agent": "Stremio-Enhanced" } }, (res) => {
                    // Handle redirects (GitHub releases use redirects)
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume(); // drain the redirect body
                        if (++redirects > MAX_REDIRECTS) {
                            fail(new Error(`Too many redirects downloading ${url}`));
                            return;
                        }
                        const redirectUrl = new URL(res.headers.location, downloadUrl).toString();
                        this.logger.info(`Following redirect to: ${redirectUrl}`);
                        request(redirectUrl);
                        return;
                    }

                    if (res.statusCode !== 200) {
                        res.resume();
                        fail(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
                        return;
                    }

                    res.on("data", (chunk: Buffer) => {
                        bytesWritten += chunk.length;
                        if (bytesWritten > MAX_DOWNLOAD_BYTES) {
                            fail(new Error(`Download of ${url} exceeded ${MAX_DOWNLOAD_BYTES} byte limit`));
                            res.destroy();
                            file.close();
                        }
                    });

                    res.pipe(file);
                    file.on("finish", () => {
                        file.close(() => {
                            if (!settled) { settled = true; resolve(); }
                        });
                    });
                    res.on("error", (err) => {
                        file.close();
                        fail(err);
                    });
                }).on("error", (err) => {
                    file.close();
                    fail(err);
                });
            };

            request(url);
        });
    }

    private static async downloadAndExtractFFmpeg(): Promise<boolean> {
        const archiveUrl = this.getFFmpegUrl();
        const archivePath = join(this.streamingServerDir, (process.platform == "win32" || process.platform == "darwin") ? "ffmpeg-release.zip" : "ffmpeg-release.tar.xz");
        
        const ffmpegPath = process.platform == "win32"
            ? join(this.streamingServerDir, "ffmpeg.exe")
            : join(this.streamingServerDir, "ffmpeg");
        const ffprobePath = process.platform == "win32"
            ? join(this.streamingServerDir, "ffprobe.exe")
            : join(this.streamingServerDir, "ffprobe");

        try {
            this.logger.info(`Downloading FFmpeg from ${archiveUrl}...`);
            await this.downloadFile(archiveUrl, archivePath);
            this.logger.info("FFmpeg archive downloaded. Extracting...");

            if (process.platform === "linux") {
                // SECURITY: use execFile (no shell) instead of execSync
                // with template strings.  Even though archivePath and
                // streamingServerDir are derived from app-controlled
                // paths, the previous template-string approach would
                // allow an attacker controlling APPDATA / HOME to
                // inject shell metacharacters into the command line.

                // List contents (one line) - safe execFile
                const listResult = await new Promise<string>((resolvePromise, reject) => {
                    execFile("tar", ["-tf", archivePath], (err, stdout) => {
                        if (err) reject(err); else resolvePromise(stdout);
                    });
                });
                const firstLine = listResult.split("\n").find(l => l.trim().length > 0) ?? "";
                const extractDir = firstLine.trim().split("/")[0];
                if (!extractDir || extractDir.includes("..")) {
                    throw new Error("Refusing to extract archive with suspicious top-level directory");
                }

                await execFileAsync("tar", ["-xf", archivePath, "-C", this.streamingServerDir]);

                const extractedDir = join(this.streamingServerDir, extractDir);

                // Use Node's fs to move files instead of shell `mv`.
                const extractedFfmpeg = join(extractedDir, "ffmpeg");
                const extractedFfprobe = join(extractedDir, "ffprobe");
                if (existsSync(extractedFfmpeg)) renameSync(extractedFfmpeg, ffmpegPath);
                if (existsSync(extractedFfprobe)) renameSync(extractedFfprobe, ffprobePath);

                chmodSync(ffmpegPath, 0o755);
                chmodSync(ffprobePath, 0o755);

                // Use Node's fs to remove the extracted directory
                // instead of `rm -rf` via shell.
                if (existsSync(extractedDir)) {
                    rmSync(extractedDir, { recursive: true, force: true });
                }
                unlinkSync(archivePath);

                this.logger.info("FFmpeg and FFprobe extracted successfully.");
                return true;
            } else if (process.platform === "darwin") {
                // SECURITY: use unzip via execFile (no shell).
                await execFileAsync("unzip", ["-o", archivePath, "-d", this.streamingServerDir]);
                chmodSync(ffmpegPath, 0o755);
                unlinkSync(archivePath);

                this.logger.info(`FFmpeg extracted successfully. Downloading FFprobe from ${this.getMacOSFFprobeUrl()}...`);

                const ffprobeArchivePath = join(this.streamingServerDir, "ffprobe-release.zip");
                await this.downloadFile(this.getMacOSFFprobeUrl(), ffprobeArchivePath);
                this.logger.info("FFprobe archive downloaded. Extracting...");
                
                await execFileAsync("unzip", ["-o", ffprobeArchivePath, "-d", this.streamingServerDir]);
                chmodSync(ffprobePath, 0o755);
                unlinkSync(ffprobeArchivePath);
                return true;
            } else if (process.platform === "win32") {
                // Handle Windows zip file natively to avoid PowerShell module issues.
                // SECURITY: unzipper.Extract by default does NOT validate
                // entries against Zip Slip (path traversal via `..` or
                // absolute paths).  We override the path inside our
                // own validator and reject any entry that would land
                // outside the destination directory.
                await new Promise<void>((resolvePromise, reject) => {
                    const destinationBase = resolve(this.streamingServerDir);
                    const stream = require('fs').createReadStream(archivePath);
                    stream
                        .pipe(unzipper.Parse())
                        .on('entry', (entry: any) => {
                            const entryPath = entry.path as string;
                            const targetPath = resolve(join(destinationBase, entryPath));
                            const rel = relative(destinationBase, targetPath);
                            // Reject any entry that escapes the destination.
                            if (rel.startsWith('..') || isAbsolute(rel)) {
                                this.logger.warn(`Refusing zip entry outside destination: ${entryPath}`);
                                entry.autodrain();
                                return;
                            }
                            entry.pipe(require('fs').createWriteStream(targetPath));
                        })
                        .on('close', resolvePromise)
                        .on('error', reject);
                });
                
                const extDir = join(this.streamingServerDir, "ffmpeg-master-latest-win64-gpl");
                const ffmpegSource = join(extDir, "bin", "ffmpeg.exe");
                const ffprobeSource = join(extDir, "bin", "ffprobe.exe");
                
                if (existsSync(ffmpegSource)) {
                    renameSync(ffmpegSource, join(this.streamingServerDir, "ffmpeg.exe"));
                }
                if (existsSync(ffprobeSource)) {
                    renameSync(ffprobeSource, join(this.streamingServerDir, "ffprobe.exe"));
                }
                
                if (existsSync(extDir)) {
                    rmSync(extDir, { recursive: true, force: true });
                }

                unlinkSync(archivePath);
                return true;
            }

            return false;
        } catch (error) {
            this.logger.error(`Failed to download/extract FFmpeg: ${error}`);
            // Cleanup on failure
            if (existsSync(archivePath)) {
                try { unlinkSync(archivePath); } catch {}
            }
            return false;
        }
    }

    public static async ensureStreamingServerFiles(): Promise<"ready" | "missing_server_js" | "missing_ffmpeg"> {
        try {
            // Create directory if it doesn't exist
            if (!existsSync(this.streamingServerDir)) {
                this.logger.info(`Creating streaming server directory: ${this.streamingServerDir}`);
                mkdirSync(this.streamingServerDir, { recursive: true });
            }

            // Check if server.js exists (user must download manually)
            if (!existsSync(this.serverScriptPath)) {
                this.logger.warn("server.js not found. User needs to download it manually.");
                return "missing_server_js";
            }

            // Check if we need to download ffmpeg/ffprobe
            // Only download if system versions are not available
            const systemFFmpeg = this.getSystemBinaryPath("ffmpeg");
            const systemFFprobe = this.getSystemBinaryPath("ffprobe");

            if (systemFFmpeg && systemFFprobe) {
                this.logger.info("Using system ffmpeg and ffprobe.");
            } else {
                // Need to download ffmpeg binaries
                const downloadedFFmpeg = process.platform == "win32"
                    ? join(this.streamingServerDir, "ffmpeg.exe")
                    : join(this.streamingServerDir, "ffmpeg");
                const downloadedFFprobe = process.platform == "win32"
                    ? join(this.streamingServerDir, "ffprobe.exe")
                    : join(this.streamingServerDir, "ffprobe");

                if (!existsSync(downloadedFFmpeg) || !existsSync(downloadedFFprobe)) {
                    this.logger.info("System ffmpeg/ffprobe not found. Downloading...");
                    const success = await this.downloadAndExtractFFmpeg();
                    if (!success) {
                        this.logger.error("Failed to download FFmpeg binaries and system ffmpeg not available.");
                        return "missing_ffmpeg";
                    }
                }
            }

            this.logger.info("All streaming server files are ready.");
            return "ready";

        } catch (error) {
            this.logger.error(`Failed to ensure streaming server files: ${error}`);
            return "missing_ffmpeg";
        }
    }

    public static async streamingServerDirExists() {
        // Check if server.js exists and we have ffmpeg/ffprobe available (either system or downloaded)
        if (!existsSync(this.streamingServerDir) || !existsSync(this.serverScriptPath)) {
            return false;
        }

        const ffmpegPath = this.getFFmpegPath();
        const ffprobePath = this.getFFprobePath();

        if (!existsSync(ffmpegPath) || !existsSync(ffprobePath)) {
            return false;
        }

        return true;
    }

    private static async fetchText(url: string): Promise<string> {
        const MAX_TEXT_BYTES = 8 * 1024 * 1024; // 8 MiB - version/toml files are tiny
        return new Promise((resolve, reject) => {
            let redirects = 0;
            const request = (fetchUrl: string) => {
                https.get(fetchUrl, { headers: { "User-Agent": "Stremio-Enhanced" } }, (res) => {
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume();
                        if (++redirects > MAX_REDIRECTS) {
                            reject(new Error(`Too many redirects fetching ${url}`));
                            return;
                        }
                        request(new URL(res.headers.location, fetchUrl).toString());
                        return;
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    let data = '';
                    let bytes = 0;
                    res.on('data', chunk => {
                        bytes += chunk.length;
                        if (bytes > MAX_TEXT_BYTES) {
                            res.destroy();
                            reject(new Error(`Response from ${url} exceeded ${MAX_TEXT_BYTES} byte limit`));
                            return;
                        }
                        data += chunk;
                    });
                    res.on('end', () => resolve(data));
                    res.on('error', err => reject(err));
                }).on("error", err => reject(err));
            };
            request(url);
        });
    }

    public static async checkServerJsUpdate(): Promise<void> {
        try {
            this.logger.info("Checking for server.js updates...");
            const tomlContent = await this.fetchText("https://raw.githubusercontent.com/Stremio/stremio-service/refs/heads/master/Cargo.toml");
            const match = tomlContent.match(/\[package\.metadata\.server\][\s\S]*?version\s*=\s*"([^"]+)"/);
            
            if (!match) {
                this.logger.warn("Could not extract server.js version from Cargo.toml");
                return;
            }
            
            const latestVersion = match[1];
            const skipVersionPath = join(Properties.enhancedPath, "skip_server_version.txt");
            const currentVersionPath = join(this.streamingServerDir, "version.txt");
            
            if (existsSync(skipVersionPath)) {
                const skippedVersion = readFileSync(skipVersionPath, "utf8").trim();
                if (skippedVersion === latestVersion) {
                    this.logger.info(`User skipped update to ${latestVersion}`);
                    return;
                }
            }
            
            let currentVersion = "";
            if (existsSync(currentVersionPath)) {
                currentVersion = readFileSync(currentVersionPath, "utf8").trim();
            }
            
            if (currentVersion === latestVersion && existsSync(this.serverScriptPath)) {
                this.logger.info(`server.js is up to date (${latestVersion})`);
                return;
            }
            
            const downloadUrl = `https://dl.strem.io/server/${latestVersion}/desktop/server.js`;
            this.latestServerJsUrl = downloadUrl;

            const isMissing = !existsSync(this.serverScriptPath);
            const promptMessage = isMissing 
                ? `The local streaming server (server.js) version ${latestVersion} is required to play videos. Do you want to download and install it now?`
                : `A new version of the Stremio local server (${latestVersion}) is available. Do you want to update it now?`;

            const response = await Helpers.showAlert(
                "question",
                "Server Update",
                promptMessage,
                ["Yes", "No", "No and don't ask again"]
            );
            
            if (response === 0) { // Yes
                if (!isMissing) {
                    this.logger.info(`Deleting old server.js to trigger update to ${latestVersion}...`);
                    if (existsSync(this.serverScriptPath)) {
                        unlinkSync(this.serverScriptPath);
                    }
                    if (existsSync(currentVersionPath)) {
                        unlinkSync(currentVersionPath);
                    }
                }
                // Write the new version to version.txt so that when they manually download it, the version is tracked
                if (!existsSync(this.streamingServerDir)) {
                    mkdirSync(this.streamingServerDir, { recursive: true });
                }
                writeFileSync(currentVersionPath, latestVersion, "utf8");
                
            } else if (response === 2) { // No and don't ask again
                writeFileSync(skipVersionPath, latestVersion, "utf8");
                this.logger.info(`Saved skip preference for version ${latestVersion}`);
            }
            
        } catch (error) {
            this.logger.error("Failed to check for server.js updates: " + error);
        }
    }

    public static start() {
        if (!existsSync(this.streamingServerDir)) {
            this.logger.warn(`Streaming server directory not found, creating: ${this.streamingServerDir}.`);
            mkdirSync(this.streamingServerDir);
        }

        if (!existsSync(this.serverScriptPath)) {
            this.logger.error("Server script not found: " + this.serverScriptPath);
            process.exit(1);
        }

        const ffmpegPath = this.getFFmpegPath();
        const ffprobePath = this.getFFprobePath();

        if (!existsSync(ffmpegPath)) {
            this.logger.error(`FFmpeg not found: ${ffmpegPath}`);
        }

        if (!existsSync(ffprobePath)) {
            this.logger.error(`FFprobe not found: ${ffprobePath}`);
        }

        this.logger.info(`Using FFmpeg: ${ffmpegPath}`);
        this.logger.info(`Using FFprobe: ${ffprobePath}`);

        const logStream = createWriteStream(this.logFilePath, { flags: "a" });

        setTimeout(() => {
            const child = fork(this.serverScriptPath, [], {
                stdio: ["ignore", "pipe", "pipe", "ipc"],
                env: {
                    ...process.env,
                    FFMPEG_BIN: ffmpegPath,
                    FFPROBE_BIN: ffprobePath,
                },
            });

            if (child.stdout) child.stdout.pipe(logStream);
            if (child.stderr) child.stderr.pipe(logStream);

            this.logger.info("Streaming server started with PID: " + child.pid);

            process.on("exit", () => {
                this.logger.info("Shutting down streaming server...");
                logStream.end();
                if (child && !child.killed) child.kill("SIGINT");
            });
        }, 0);
    }
}

export default StreamingServer;
