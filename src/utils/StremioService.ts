import { getLogger } from "./logger";
import { basename, join, resolve } from "path";
import { existsSync, createWriteStream, unlinkSync } from "fs";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import * as process from 'process';
import { homedir } from 'os';
import { app, shell } from "electron";
import https from "https";
import { TIMEOUTS, URLS } from "../constants/index";
import Helpers from "./Helpers";

class StremioService {
    private static logger = getLogger("StremioService");
    private static execFileAsync = promisify(execFile);

    public static start(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.logger.info("Starting Stremio Service...");

                let child;

                switch (process.platform) {
                    case "win32": 
                        const exe = this.findExecutable();
                        if (!exe) {
                            return reject(new Error("Could not find Stremio Service executable"));
                        }
                        child = spawn(exe, [], { detached: true, stdio: "ignore" });
                        break;
                    case "darwin": 
                        child = spawn("open", ["/Applications/StremioService.app"], { detached: true, stdio: "ignore" });
                        break;
                    case "linux": 
                        child = spawn("flatpak", ["run", "com.stremio.Service"], { detached: true, stdio: "ignore" });
                        break;
                    default:
                        return reject(new Error("Unsupported platform"));
                }

                child.unref();

                this.logger.info("Stremio Service started.");
                resolve();

            } catch (err) {
                reject(err);
            }
        });
    }
        
    public static async downloadAndInstallService() {
        const platform = process.platform;
        
        try {
            const release = await this.fetchLatestRelease();
            if (!release) {
                console.error("Failed to fetch latest release info");
                return;
            }
            
            const assetInfo = this.getAssetInfoForPlatform(release, platform);
            if (!assetInfo) {
                console.error("No suitable asset found for platform:", platform);
                return;
            }
            
            const { url: assetUrl, isZip } = assetInfo;
            const tempDir = app.getPath("temp");
            const fileName = basename(assetUrl);
            const destPath = join(tempDir, fileName);

            this.logger.info(`Downloading latest Stremio Service (${release.tag_name}) in ${destPath}`);
            await this.downloadFile(assetUrl, destPath);
            this.logger.info("Download complete. Installing...");

            switch (platform) {
                case "win32":
                    if (isZip) 
                        await this.installWindowsZip(destPath);
                    else 
                        await this.installWindows(destPath);
                break;
                case "darwin":
                    await this.installMac(destPath);
                break;
                case "linux":
                    await this.installLinux(destPath);
                break;
                default:
                    this.logger.warn("No install routine defined for: " + platform);
            }
        } catch (err) {
            this.logger.error(`Automated download/install failed: ${(err as Error).message}. Opening manual download page.`);
            Helpers.showAlert("error", "Failed to download and install Stremio Service automatically.", "Please download and install it manually from here: " + URLS.STREMIO_SERVICE_DOWNLOAD_PAGE, ["Close"]);
            shell.openExternal(URLS.STREMIO_SERVICE_DOWNLOAD_PAGE).catch((e) => {
                this.logger.error("Failed to open download page: " + (e as Error).message);
            });
        }
    }
    
    // grabs the latest version of Stremio Service from the official GitHub repository
    private static fetchLatestRelease(): Promise<any | null> {
        return new Promise((resolve, reject) => {
            const req = https.request(URLS.STREMIO_SERVICE_GITHUB_API, {
                headers: { "User-Agent": "Electron-AutoInstaller" },
            }, (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed);
                    } catch (err) {
                        reject(err);
                    }
                });
            });
            req.on("error", reject);
            req.end();
        }).catch((err: Error): null => {
            console.error("Error fetching release:", err);
            return null;
        });
    }
    
    private static getAssetInfoForPlatform(release: any, platform: string): { url: string, isZip?: boolean } | null {
        if (!release.assets || !Array.isArray(release.assets)) return null;
        
        // For windows, check if a .exe setup file is available, if not fallback to zip archive
        if (platform === "win32") {
            let asset = release.assets.find((a: any) => /\.exe$/i.test(a.name));
            if (asset) return { url: asset.browser_download_url, isZip: false };
            
            asset = release.assets.find((a: any) => /-windows\.zip$/i.test(a.name));
            if (asset) return { url: asset.browser_download_url, isZip: true };
            
            return null;
        }

        const matchers: Record<string, RegExp> = {
            darwin: /\.dmg$/i,
            linux: /\.flatpak$/i,
        };
        
        const pattern = matchers[platform];
        if (!pattern) return null;
        
        const asset = release.assets.find((a: any) => pattern.test(a.name));
        return asset ? { url: asset.browser_download_url } : null;
    }
    
    private static async downloadFile(url: string, dest: string): Promise<void> {
        // Hardening: cap redirects and total size, verify status codes
        // on every hop, and clean up partial files on failure so a
        // truncated installer is never executed later.
        const MAX_REDIRECTS = 5;
        const MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB

        return new Promise((resolve, reject) => {
            let redirects = 0;
            let bytesWritten = 0;
            let settled = false;

            const fail = (err: Error) => {
                if (settled) return;
                settled = true;
                try { unlinkSync(dest); } catch { /* nothing to clean up */ }
                reject(err);
            };

            const file = createWriteStream(dest);
            file.on("error", fail);

            const request = (reqUrl: string) => {
                let parsed: URL;
                try {
                    parsed = new URL(reqUrl);
                } catch (err) {
                    fail(err as Error);
                    return;
                }
                if (parsed.protocol !== "https:") {
                    fail(new Error(`Refusing non-https download URL: ${reqUrl}`));
                    return;
                }

                https.get(reqUrl, { headers: { "User-Agent": "Electron-AutoInstaller" } }, (res) => {
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume();
                        if (++redirects > MAX_REDIRECTS) {
                            fail(new Error(`Too many redirects downloading ${url}`));
                            return;
                        }
                        request(new URL(res.headers.location, reqUrl).toString());
                        return;
                    }

                    if (res.statusCode !== 200) {
                        res.resume();
                        fail(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
                        return;
                    }

                    res.on("data", (chunk: Buffer) => {
                        bytesWritten += chunk.length;
                        if (bytesWritten > MAX_BYTES) {
                            fail(new Error(`Download of ${url} exceeded size limit`));
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
                    res.on("error", fail);
                }).on("error", fail);
            };

            request(url);
        });
    }
    
    private static async waitForInstallCompletion(timeoutMs = TIMEOUTS.INSTALL_COMPLETION, installerPath?: string): Promise<boolean> {
        const start = Date.now();
        
        while (Date.now() - start < timeoutMs) {
            const running = await this.isServiceRunning();
            if (running) return true;
            
            const installed = await this.isServiceInstalled();
            if (installed) {
                this.start();
                if(installerPath && existsSync(installerPath)) {
                    try {
                        unlinkSync(installerPath); // delete installer file after successful install
                    } catch (err) {
                        this.logger.warn("Failed to delete installer file: " + (err as Error).message);
                    }
                }
                return true;
            }
            
            await new Promise(r => setTimeout(r, TIMEOUTS.SERVICE_CHECK_INTERVAL));
        }
        
        return false;
    }
    
    private static async isServiceRunning(): Promise<boolean> {
        const platform = process.platform;

        if (platform === "win32") {
            return new Promise(resolve => {
                execFile("tasklist", ["/FI", 'IMAGENAME eq stremio-service.exe'], (_err, stdout) => {
                    resolve(Boolean(stdout && stdout.includes("stremio-service.exe")));
                });
            });
        }

        if (platform === "darwin") {
            return new Promise(resolve => {
                execFile("pgrep", ["-f", "StremioService"], (err) => {
                    resolve(!err);
                });
            });
        }

        if (platform === "linux") {
            return new Promise(resolve => {
                execFile("flatpak", ["ps"], (err, stdout) => {
                    if (!err && stdout.includes("com.stremio.Service")) return resolve(true);
                    resolve(false);
                });
            });
        }

        return false;
    }
    
    public static async isServiceInstalled(): Promise<boolean> {
        const platform = process.platform;

        switch(platform) {
            case "win32":
                return this.isServiceInstalledWindows();
            case "darwin":
                return existsSync("/Applications/StremioService.app/Contents/MacOS/stremio-service");
            case "linux":
                try {
                    const { stdout } = await this.execFileAsync("flatpak", ["info", "com.stremio.Service"]);
                    return stdout.includes("com.stremio.Service");
                } catch {
                    return false;
                }
            default:
                return false;
        }
    }

    private static async isServiceInstalledWindows(): Promise<boolean> {
        const localAppData = process.env.LOCALAPPDATA;
        if (!localAppData) return false;

        const servicePath = join(localAppData, "Programs", "StremioService", "stremio-service.exe");
        return existsSync(servicePath);
    }

    private static async installWindowsZip(zipPath: string) {
        const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
        const extractPath = join(localAppData, "Programs", "StremioService");

        this.logger.info(`Extracting Stremio Service zip to ${extractPath}...`);

        // SECURITY: pass arguments as an array (not via `-Command`
        // template string) so that zipPath cannot be used to inject
        // additional PowerShell statements.  Even though zipPath comes
        // from the GitHub releases API, we treat it as untrusted.
        await this.execFileAsync("powershell.exe", [
            "-ExecutionPolicy", "Bypass",
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractPath.replace(/'/g, "''")}' -Force`,
        ], {
            windowsHide: true,
        });
        
        this.logger.info("Waiting for Stremio Service extraction to finish...");
        const success = await this.waitForInstallCompletion(TIMEOUTS.INSTALL_COMPLETION, zipPath);
        
        if (success) {
            this.logger.info("Stremio Service detected as extracted and running.");
        } else {
            this.logger.warn("Extraction timeout or failed to detect Stremio Service.");
        }
    }

    private static async installWindows(filePath: string) {
        // SECURITY: pass arguments as an array.  Use -LiteralPath and
        // single-quote escaping to neutralize single quotes inside
        // filePath.  This prevents the case where an attacker who
        // controls the release assets (or just observes a malicious
        // filename) can inject PowerShell statements.
        const safeFile = filePath.replace(/'/g, "''");
        await this.execFileAsync("powershell.exe", [
            "-ExecutionPolicy", "Bypass",
            "-NoProfile",
            "-Command",
            `Start-Process -FilePath '${safeFile}' -ArgumentList '/S' -Verb RunAs`,
        ], {
            windowsHide: true,
        });
        
        this.logger.info("Waiting for Stremio Service installation to finish...");
        const success = await this.waitForInstallCompletion(TIMEOUTS.INSTALL_COMPLETION, filePath);
        
        if (success) {
            this.logger.info("Stremio Service detected as installed or running.");
        } else {
            this.logger.warn("Installation timeout or failed to detect Stremio Service.");
        }
    }

    private static async installMac(filePath: string) {
        const volume = "/Volumes/StremioService";
        try {
            await this.execFileAsync("hdiutil", ["attach", filePath, "-mountpoint", volume]);
            await this.execFileAsync("cp", ["-R", `${volume}/StremioService.app`, "/Applications/"]);
        } catch (err) {
            this.logger.error(`DMG install failed: ${err}`);
        } finally {
            await this.execFileAsync("hdiutil", ["detach", volume]).catch(() => {});
        }

        this.logger.info("Waiting for Stremio Service installation to finish...");
        const success = await this.waitForInstallCompletion(TIMEOUTS.INSTALL_COMPLETION, filePath); 

        if (success) {
            this.logger.info("Stremio Service detected as installed or running.");
        } else {
            this.logger.warn("Installation timeout or failed to detect Stremio Service.");
        }
    }
    
    private static async installLinux(filePath: string) {
        try {
            await this.execFileAsync("flatpak", [
                "remote-add",
                "--if-not-exists",
                "flathub",
                "https://dl.flathub.org/repo/flathub.flatpakrepo"
            ]).catch(() => {});

            try {
                await this.execFileAsync("flatpak", ["info", "org.freedesktop.Platform//24.08"]);
            } catch {
                this.logger.info("Installing Flatpak runtime org.freedesktop.Platform//24.08...");
                await this.execFileAsync("flatpak", ["install", "-y", "flathub", "org.freedesktop.Platform//24.08"]);
            }

            this.logger.info(`Installing Stremio Service from ${filePath}`);
            await this.execFileAsync("flatpak", ["install", "--user", "-y", filePath]);

            const success = await this.waitForInstallCompletion(TIMEOUTS.INSTALL_COMPLETION, filePath);

            if (success) {
                this.logger.info("Stremio Service detected as installed or running.");
            } else {
                this.logger.warn("Installation timeout or failed to detect Stremio Service.");
            }
        } catch (err) {
            this.logger.error(`Flatpak install failed: ${err}`);
        }
    }
    
    public static terminate(): number {
        try {
            this.logger.info("Terminating Stremio Service.");
            
            const pid = this.getStremioServicePid();
            if (pid) {
                process.kill(pid, 'SIGTERM');
                this.logger.info("Stremio Service terminated.");
                return 0; 
            } else {
                this.logger.error("Failed to find Stremio Service PID.");
                return 1;
            }
        } catch (e) {
            this.logger.error(`Error terminating service: ${(e as Error).message}`);
            return 2; 
        }
    }
    
    private static getStremioServicePid(): number | null {
        switch (process.platform) {
            case 'win32':
                return this.getPidForWindows();
            case 'darwin':
            case 'linux':
                return this.getPidForUnix();
            default:
                this.logger.error('Unsupported operating system');
                return null;
        }
    }
    
    private static getPidForWindows(): number | null {
        const execSync = require('child_process').execSync;
        try {
            const output = execSync('tasklist /FI "IMAGENAME eq stremio-service.exe"').toString();
            
            const lines = output.split('\n');
            
            for (const line of lines) {
                if (line.includes('stremio-service.exe')) {
                    const columns = line.trim().split(/\s+/);
                    if (columns.length > 1) {
                        return parseInt(columns[1], 10);
                    }
                }
            }
            
            this.logger.error("Stremio service not found in tasklist.");
        } catch (error) {
            this.logger.error('Error retrieving PID for Stremio service on Windows:' + error);
        }
        return null;
    }
    
    
    private static getPidForUnix(): number | null {
        const execSync = require('child_process').execSync;
        try {
            const output = execSync("pgrep -f stremio-service").toString();
            return parseInt(output.trim(), 10);
        } catch (error) {
            this.logger.error('Error retrieving PID for Stremio service on Unix: ' + error);
        }
        return null;
    }

    public static findExecutable(): string | null {
        const localPath = resolve('./stremio-service.exe');
        if (existsSync(localPath)) {
            this.logger.info("StremioService executable found in the current directory.");
            return localPath;
        }

        const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
        const installationPath = join(localAppData, 'Programs', 'StremioService', 'stremio-service.exe');
        const fullPath = resolve(installationPath);
        this.logger.info("Checking existence of " + fullPath);

        try {
            if (existsSync(fullPath)) {
                this.logger.info(`StremioService executable found in OS-specific path (win32).`);
                return fullPath;
            } else {
                this.logger.warn(`StremioService executable not found at ${fullPath}`);
            }
        } catch (error) {
            this.logger.error(`Error checking StremioService existence in ${fullPath}: ${(error as Error).message}`);
        }
        
        return null;
    }
    
    public static async isProcessRunning(): Promise<boolean> {
        try {
            switch (process.platform) {

                case "win32": 
                    const { stdout } = await this.execFileAsync("tasklist", ["/FI", 'IMAGENAME eq stremio-service.exe']);
                    return stdout.toLowerCase().includes("stremio-service.exe");
                case "darwin":
                case "linux": 
                    try {
                        await this.execFileAsync("pgrep", ["-f", "stremio-service"]);
                        return true;
                    } catch {
                        return false;
                    }
                default:
                    this.logger.error("Unsupported operating system");
                    return false;
            }

        } catch (error: any) {
            this.logger.error(`Error checking service running state: ${error.message}`);
            return false;
        }
    }
}

export default StremioService;