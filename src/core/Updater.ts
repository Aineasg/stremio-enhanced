import { homedir } from "os";
import { shell } from "electron"
import { readFileSync, writeFileSync } from "fs";
import { getLogger } from "../utils/logger";
import { join } from "path";
import { getUpdateModalTemplate } from "../components/update-modal/updateModal";
import { URLS } from "../constants";
import Helpers from "../utils/Helpers";
import { isSafeFileName, isSafeUrl } from "../utils/sanitize";

class Updater {
    private static logger = getLogger("Updater");
    private static versionCache: string | null = null;

    /**
     * Check for updates and show update modal if available
     * @param showNoUpdatePrompt - Whether to show a message if no update is available
     *
     * NOTE: this method is called from BOTH the renderer preload (which
     * renders an in-page modal) and the main process (via the
     * UPDATE_CHECK_USER IPC).  When running in the main process there
     * is no `document`, so we fall back to a native dialog - previously
     * the DOM path threw a ReferenceError and users saw a false
     * "Update check failed" error whenever an update existed.
     */
    public static async checkForUpdates(showNoUpdatePrompt: boolean): Promise<boolean> {
        try {
            const latestVersion = await this.getLatestVersion();
            const currentVersion = this.getCurrentVersion();
            
            // SECURITY: validate version strings before comparison.
            // A malicious version endpoint could otherwise pollute
            // logs / be displayed in the UI unfiltered.
            if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(latestVersion)) {
                this.logger.error(`Refusing to use latest version with unexpected format: ${JSON.stringify(latestVersion)}`);
                return false;
            }
            
            if (Helpers.isNewerVersion(latestVersion, currentVersion)) {
                this.logger.info(`Update available: v${latestVersion} (current: v${currentVersion})`);

                if (typeof document === "undefined") {
                    // Main process: no DOM available - use a native dialog.
                    await this._showUpdateDialogMain(currentVersion, latestVersion);
                } else {
                    const modalsContainer = document.getElementsByClassName("modals-container")[0];
                    if (modalsContainer) {
                        modalsContainer.innerHTML = await getUpdateModalTemplate(currentVersion, latestVersion);
                        
                        let downloadBtn = document.getElementById("download-update")
                        downloadBtn?.addEventListener("click", () => {
                            this.downloadAndExecuteUpdate(downloadBtn as HTMLElement);
                        })
                    }
                }
                return true;
            } else if (showNoUpdatePrompt) {
                await Helpers.showAlert(
                    "info", 
                    "No update available!", 
                    `You're running the latest version (v${currentVersion}).`, 
                    ["OK"]
                );
            }
            return false;
        } catch (error) {
            this.logger.error(`Failed to check for updates: ${(error as Error).message}`);
            if (showNoUpdatePrompt) {
                await Helpers.showAlert(
                    "error",
                    "Update check failed",
                    "Could not check for updates. Please check your internet connection.",
                    ["OK"]
                );
            }
            return false;
        }
    }

    /**
     * Main-process update flow: native message box instead of the
     * in-page modal (which requires a renderer `document`).
     */
    private static async _showUpdateDialogMain(currentVersion: string, latestVersion: string): Promise<void> {
        const notes = await this.getReleaseNotes();
        const plainNotes = notes
            // Native message boxes are plain text - strip markdown
            // markup so the dialog stays readable.
            .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
            .replace(/[#*_>`]/g, "")
            .slice(0, 1500);

        const result = await Helpers.showAlert(
            "info",
            `Update available: v${latestVersion}`,
            `A new version of Stremio Enhanced is available (v${currentVersion} -> v${latestVersion}).\n\n${plainNotes}`,
            ["Download Update", "Open Release Page", "Later"]
        );

        if (result === 0) {
            await this.downloadAndExecuteUpdate();
        } else if (result === 1) {
            await shell.openExternal(URLS.RELEASES_PAGE);
        }
    }

    /**
     * Fetch the latest version from GitHub
     */
    public static async getLatestVersion(): Promise<string> {
        const response = await fetch(URLS.VERSION_CHECK);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const version = (await response.text()).trim();
        this.logger.info(`Latest version available: v${version}`);
        return version;
    }

    /**
     * Get the current installed version
     */
    public static getCurrentVersion(): string {
        if (this.versionCache) {
            return this.versionCache;
        }
        
        try {
            this.versionCache = readFileSync(
                join(__dirname, "../", "../", "version"), 
                "utf-8"
            ).trim();
            return this.versionCache;
        } catch (error) {
            this.logger.error(`Failed to read version file: ${(error as Error).message}`);
            return "0.0.0";
        }
    }

    /**
     * Fetch release notes from GitHub API
     */
    public static async getReleaseNotes(): Promise<string> {
        try {
            const response = await fetch(URLS.RELEASES_API);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            return data.body || "No release notes available.";
        } catch (error) {
            this.logger.error(`Failed to fetch release notes: ${(error as Error).message}`);
            return "Could not load release notes.";
        }
    }

    /**
     * Download the update for the current platform and open / reveal it.
     * @param btnElement - optional button whose label reflects progress
     *   (only available when called from the renderer modal).
     */
    public static async downloadAndExecuteUpdate(btnElement?: HTMLElement): Promise<void> {
        try {
            const setBtnLabel = (text: string) => {
                if (!btnElement) return;
                btnElement.innerText = text;
            };

            setBtnLabel("Finding Download...");
            if (btnElement) btnElement.style.pointerEvents = "none";

            const asset = await this.getDownloadUrl();
            if (!asset) {
                throw new Error("Could not find a valid download for your Operating System.");
            }

            // SECURITY: validate the asset name + URL one more time
            // before writing to disk.  We don't fully trust the
            // releases API response to be benign.
            if (!isSafeFileName(asset.name)) {
                throw new Error(`Refusing asset with unsafe file name: ${asset.name}`);
            }
            if (!isSafeUrl(asset.url, ["github.com", "objects.githubusercontent.com", "github-releases.s3.amazonaws.com"])) {
                throw new Error(`Refusing to download from untrusted host: ${asset.url}`);
            }

            this.logger.info(`Downloading update: ${asset.name}...`);
            setBtnLabel("Downloading...");
            
            const downloadsPath = join(homedir(), 'Downloads');
            const filePath = join(downloadsPath, asset.name);

            const response = await fetch(asset.url);
            if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
            
            const buffer = Buffer.from(await response.arrayBuffer());
            // SECURITY: cap size at 256 MiB to prevent runaway downloads.
            if (buffer.length > 256 * 1024 * 1024) {
                throw new Error("Downloaded file exceeds 256 MiB safety limit.");
            }
            writeFileSync(filePath, buffer);

            this.logger.info(`Download complete: ${filePath}`);
            setBtnLabel("Downloaded!");

            const isSetupOrMac = asset.name.includes("Setup") || asset.name.endsWith(".dmg");

            if (isSetupOrMac) {
                this.logger.info("Installer or DMG detected. Executing/Mounting...");
                shell.openPath(filePath); 
            } else {
                this.logger.info("Non-setup file detected. Highlighting in file explorer...");
                shell.showItemInFolder(filePath); 
            }

        } catch (error) {
            this.logger.error(`Update failed: ${(error as Error).message}`);
            if (btnElement) {
                btnElement.innerText = "Download Failed";
                btnElement.style.pointerEvents = "auto";
            } else {
                await Helpers.showAlert(
                    "error",
                    "Update failed",
                    `Downloading the update failed: ${(error as Error).message}`,
                    ["OK"]
                );
            }
        }
    }

    private static async getDownloadUrl(): Promise<{ url: string, name: string } | null> {
        try {
            const response = await fetch(URLS.RELEASES_API);
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            
            const data = await response.json();
            const assets = data.assets;
            if (!Array.isArray(assets)) {
                this.logger.error("Release assets field is not an array");
                return null;
            }
            
            const currentPlatform = process.platform;
            const currentArch = process.arch;
            
            let targetAsset;

            if (currentPlatform === "win32") {
                targetAsset = assets.find((a: any) => a.name.includes("Setup") && a.name.endsWith(".exe")) 
                           || assets.find((a: any) => a.name.endsWith(".exe"));
            } 
            else if (currentPlatform === "darwin") {
                if (currentArch === "arm64") {
                    targetAsset = assets.find((a: any) => a.name.includes("arm64") && a.name.endsWith(".dmg"));
                } else {
                    targetAsset = assets.find((a: any) => !a.name.includes("arm64") && a.name.endsWith(".dmg"));
                }
            } 
            else if (currentPlatform === "linux") {
                if (currentArch === "arm64") {
                    targetAsset = assets.find((a: any) => a.name.includes("arm64") && a.name.endsWith(".AppImage"));
                } else {
                    targetAsset = assets.find((a: any) => !a.name.includes("arm64") && a.name.endsWith(".AppImage"));
                }
            }

            if (targetAsset && typeof targetAsset.browser_download_url === 'string' && typeof targetAsset.name === 'string') {
                return { url: targetAsset.browser_download_url, name: targetAsset.name };
            }
            return null;

        } catch (error) {
            this.logger.error(`Failed to fetch release assets: ${(error as Error).message}`);
            return null;
        }
    }
}

export default Updater;
