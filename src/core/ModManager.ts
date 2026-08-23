import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { shell } from "electron";
import { basename, join } from "path";
import Properties from "./Properties";
import { MetaData } from "../interfaces/MetaData";
import { getLogger } from "../utils/logger";
import { FILE_EXTENSIONS, URLS } from "../constants";
import ExtractMetaData from "../utils/ExtractMetaData";
import RegistryMetaData from "../interfaces/RegistryMetaData";
import Helpers from "../utils/Helpers";
import { isSafeFileName, isSafeFetchUrl, isSafeUrl, safeJoin } from "../utils/sanitize";

class ModManager {
    private static logger = getLogger("ModManager");

    public static getPluginContent(pluginName: string): string | null {
        if (!isSafeFileName(pluginName)) {
            this.logger.error(`Rejected getPluginContent: unsafe plugin name ${JSON.stringify(pluginName)}`);
            return null;
        }
        const pluginPath = safeJoin(Properties.pluginsPath, pluginName);
        if (!existsSync(pluginPath)) return null;
        try {
            return readFileSync(pluginPath, "utf-8");
        } catch (err) {
            this.logger.error(`Failed to read plugin ${pluginName}: ${(err as Error).message}`);
            return null;
        }
    }

    public static getInstalledThemes(): string[] {
        const dirPath = Properties.themesPath;
        if (!existsSync(dirPath)) return [];
        try {
            return readdirSync(dirPath).filter(f => {
                if (!isSafeFileName(f)) return false;
                try {
                    return statSync(join(dirPath, f)).isFile();
                } catch {
                    return false;
                }
            });
        } catch (err) {
            this.logger.error(`Failed to list themes: ${(err as Error).message}`);
            return [];
        }
    }

    public static getInstalledPlugins(): string[] {
        const dirPath = Properties.pluginsPath;
        if (!existsSync(dirPath)) return [];
        try {
            return readdirSync(dirPath).filter(f => {
                if (!isSafeFileName(f)) return false;
                try {
                    return statSync(join(dirPath, f)).isFile();
                } catch {
                    return false;
                }
            });
        } catch (err) {
            this.logger.error(`Failed to list plugins: ${(err as Error).message}`);
            return [];
        }
    }

    public static isThemeInstalled(fileName: string): boolean {
        if (!isSafeFileName(fileName)) return false;
        return this.getInstalledThemes().includes(fileName);
    }

    public static isPluginInstalled(fileName: string): boolean {
        if (!isSafeFileName(fileName)) return false;
        return this.getInstalledPlugins().includes(fileName);
    }

    public static openFolder(folderPath: string): void {
        // SECURITY: only allow opening the canonical themes / plugins
        // folders.  Anything else (including ".." tricks) is rejected.
        if (folderPath !== Properties.themesPath && folderPath !== Properties.pluginsPath) {
            this.logger.error(`Refused to open arbitrary folder: ${folderPath}`);
            return;
        }
        shell.openPath(folderPath).then(error => {
            if (error) this.logger.error(`Failed to open folder ${folderPath}: ${error}`);
        });
    }

    public static async fetchMods(): Promise<{ plugins: unknown[]; themes: unknown[] }> {
        // SECURITY: pin the URL to the constant from constants/index.ts
        // (do not accept a URL from the caller – registry must be the
        // trusted one).
        const response = await fetch(URLS.REGISTRY);
        if (!response.ok) {
            throw new Error(`Failed to fetch registry: HTTP ${response.status}`);
        }
        const data = await response.json() as { plugins?: unknown[]; themes?: unknown[] };
        return {
            plugins: Array.isArray(data.plugins) ? data.plugins : [],
            themes: Array.isArray(data.themes) ? data.themes : [],
        };
    }

    /**
     * Download a plugin / theme file from a registry URL.
     *
     * SECURITY: `modLink` is validated to be an http(s) URL pointing at
     * one of the trusted registry hosts (GitHub raw content, github.io
     * for the stremio-enhanced-registry, or directly raw.githubusercontent.com).
     * The output file name is derived from the URL path and validated
     * via `isSafeFileName` to prevent path traversal when writing.
     */
    public static async downloadMod(modLink: string, type: "plugin" | "theme"): Promise<string> {
        const allowedHosts = [
            "raw.githubusercontent.com",
            "github.com",
            "objects.githubusercontent.com",
        ];
        if (!isSafeUrl(modLink, allowedHosts)) {
            this.logger.error(`Refused to download ${type} from disallowed URL: ${modLink}`);
            throw new Error("Download URL is not allowed.");
        }

        this.logger.info(`Downloading ${type} from: ${modLink}`);
        const response = await fetch(modLink);
        if (!response.ok) throw new Error(`Failed to download: ${response.status}`);

        const saveDir = type === "plugin" ? Properties.pluginsPath : Properties.themesPath;
        if (!existsSync(saveDir)) mkdirSync(saveDir, { recursive: true });

        const parsedUrl = new URL(modLink);
        const rawFilename = basename(parsedUrl.pathname) || `${type}-${Date.now()}`;
        if (!isSafeFileName(rawFilename)) {
            throw new Error(`Reflected file name is not safe: ${rawFilename}`);
        }
        const filePath = safeJoin(saveDir, rawFilename);

        const buffer = Buffer.from(await response.arrayBuffer());
        // Cap the size to a sane maximum (8 MiB) to prevent resource
        // exhaustion / disk-fill attacks from a malicious registry.
        if (buffer.length > 8 * 1024 * 1024) {
            throw new Error(`Downloaded ${type} exceeds 8 MiB size limit`);
        }
        writeFileSync(filePath, buffer);

        this.logger.info(`Downloaded ${type} saved to: ${filePath}`);
        return filePath;
    }

    public static deleteModFile(fileName: string, type: "plugin" | "theme"): void {
        if (!isSafeFileName(fileName)) {
            this.logger.error(`Refused to delete ${type} file with unsafe name: ${fileName}`);
            return;
        }
        const targetPath = safeJoin(
            type === "plugin" ? Properties.pluginsPath : Properties.themesPath,
            fileName
        );
        if (existsSync(targetPath)) {
            try {
                unlinkSync(targetPath);
                this.logger.info(`Deleted ${type} file: ${fileName}`);
            } catch (err) {
                this.logger.error(`Failed to delete ${type} file ${fileName}: ${(err as Error).message}`);
            }
        }
    }

    public static saveModFile(fileName: string, type: "plugin" | "theme", content: string): void {
        if (!isSafeFileName(fileName)) {
            this.logger.error(`Refused to save ${type} file with unsafe name: ${fileName}`);
            return;
        }
        // Cap content length to prevent disk-fill / memory exhaustion.
        if (typeof content !== "string" || content.length > 16 * 1024 * 1024) {
            this.logger.error(`Refused to save ${type} file: content too large or invalid.`);
            return;
        }
        const targetPath = safeJoin(
            type === "plugin" ? Properties.pluginsPath : Properties.themesPath,
            fileName
        );
        try {
            writeFileSync(targetPath, content, 'utf-8');
        } catch (err) {
            this.logger.error(`Failed to save ${type} file ${fileName}: ${(err as Error).message}`);
        }
    }

    public static async checkUpdateData(itemFile: string): Promise<{
        hasUpdate: boolean;
        newContent?: string;
        newMetaData?: MetaData;
        installedMetaData?: MetaData;
        registryVersion?: string | null;
        updateUrl?: string;
    } | null> {
        if (!isSafeFileName(itemFile)) {
            this.logger.error(`Refused to check update for unsafe file name: ${itemFile}`);
            return null;
        }
        const type = itemFile.endsWith(FILE_EXTENSIONS.THEME) ? "theme" : "plugin";
        const itemPath = safeJoin(
            type === "theme" ? Properties.themesPath : Properties.pluginsPath,
            itemFile
        );

        const installedMetaData = ExtractMetaData.extractMetadataFromFile(itemPath) as MetaData | null;
        if (!installedMetaData?.updateUrl || installedMetaData.updateUrl === "none") return null;

        // SECURITY: validate that the update URL is a safe PUBLIC http(s)
        // URL before the main process fetches it.  This runs in the main
        // process where fetch() has no CORS restrictions, so a plugin
        // could otherwise use its updateUrl as a proxy into the local
        // network / cloud metadata endpoints (SSRF + CORS bypass).
        if (!isSafeFetchUrl(installedMetaData.updateUrl)) {
            this.logger.error(`Plugin ${installedMetaData.name} has unsafe updateUrl: ${installedMetaData.updateUrl}`);
            return null;
        }

        try {
            const request = await fetch(installedMetaData.updateUrl);
            if (request.status !== 200) return null;

            const responseText = await request.text();
            // Cap response size to avoid unbounded memory use.
            if (responseText.length > 16 * 1024 * 1024) {
                this.logger.error(`Update payload for ${installedMetaData.name} exceeds 16 MiB`);
                return null;
            }
            const extractedMetaData = ExtractMetaData.extractMetadataFromText(responseText) as MetaData | null;
            
            if (!extractedMetaData) {
                this.logger.warn(`Failed to check for updates for the ${type} ${installedMetaData.name}. The provided updateUrl leads to content with invalid metadata.`);
                return null;
            }

            if (Helpers.isNewerVersion(extractedMetaData.version, installedMetaData.version)) {
                this.logger.info(`New update found for plugin ${installedMetaData.name} (v${installedMetaData.version} -> v${extractedMetaData.version})`)

                let registryVersion = null;
                if (type === "plugin") {
                    registryVersion = await this.getRegistryPluginVersion(itemFile);
                }
                
                return {
                    hasUpdate: true,
                    newContent: responseText,
                    newMetaData: extractedMetaData,
                    installedMetaData,
                    registryVersion,
                    updateUrl: installedMetaData.updateUrl
                };
            }
            return { hasUpdate: false, installedMetaData };
        } catch (error) {
            this.logger.error(`Error checking updates for ${itemFile}: ${(error as Error).message}`);
            return null;
        }
    }

    private static async getRegistryPluginVersion(itemFile: string): Promise<string | null> {
        let registryData = await this.fetchMods();
        let registryPlugins = registryData.plugins as unknown[] || [];
        const plugin = registryPlugins.find(p => (p as RegistryMetaData).download?.endsWith(itemFile)) as RegistryMetaData | undefined;
        return plugin ? plugin.version : null;
    }
}

export default ModManager;
