import { readdirSync, existsSync } from "fs";
import { join } from "path";
import properties from "../../core/Properties";
import Helpers from "../../utils/Helpers";
import logger from "../../utils/logger";
import { STORAGE_KEYS, FILE_EXTENSIONS, TIMEOUTS } from "../../constants";
import { modController } from "../ui/mod/modController";
import { isSafeFileName } from "../../utils/sanitize";
import { applyThemeStylesheet } from "../../utils/themeLoader";

export function initializeUserSettings(): void {
    const defaults: Record<string, string> = {
        [STORAGE_KEYS.ENABLED_PLUGINS]: "[]",
        [STORAGE_KEYS.CHECK_UPDATES_ON_STARTUP]: "true",
        [STORAGE_KEYS.DISCORD_RPC]: "false",
    };
    
    for (const [key, defaultValue] of Object.entries(defaults)) {
        if (!localStorage.getItem(key)) {
            localStorage.setItem(key, defaultValue);
        }
    }
}

export function reloadServer(): void {
    setTimeout(() => {
        Helpers._eval(`core.dispatch({ action: 'StreamingServer', args: { action: 'Reload' } });`);
        logger.info("Stremio streaming server reloaded.");
    }, TIMEOUTS.SERVER_RELOAD_DELAY);
}

export function applyUserTheme(): void {
    const currentTheme = localStorage.getItem(STORAGE_KEYS.CURRENT_THEME);

    if (!currentTheme || currentTheme === "Default") {
        localStorage.setItem(STORAGE_KEYS.CURRENT_THEME, "Default");
        return;
    }

    // SECURITY: currentTheme comes from localStorage which is
    // attacker-writable.  Reject any value that's not a safe leaf
    // file name to prevent path traversal.
    if (!isSafeFileName(currentTheme)) {
        logger.error(`Refusing to apply current theme with unsafe name: ${currentTheme}`);
        localStorage.setItem(STORAGE_KEYS.CURRENT_THEME, "Default");
        return;
    }

    const themePath = join(properties.themesPath, currentTheme);

    if (!existsSync(themePath)) {
        localStorage.setItem(STORAGE_KEYS.CURRENT_THEME, "Default");
        return;
    }

    // SECURITY + FIX: inject the CSS text via <style> instead of a
    // <link href="file://..."> - file:// subresources are blocked on
    // https:// pages now that webSecurity is (correctly) enabled.
    applyThemeStylesheet(currentTheme);
}

export function loadEnabledPlugins(): void {
    // Robustness: the plugins dir may not exist yet (e.g. first run
    // where directory creation failed) - don't crash the preload.
    if (!existsSync(properties.pluginsPath)) {
        logger.warn("Plugins directory does not exist yet; no plugins loaded.");
        return;
    }

    // SECURITY: filter the directory listing to only files matching
    // our safe file name rules so a tampered-with plugins folder
    // can't trick us into loading `../../foo.plugin.js`.
    const pluginsToLoad = readdirSync(properties.pluginsPath)
        .filter(f => f.endsWith(FILE_EXTENSIONS.PLUGIN) && isSafeFileName(f));
    
    const enabledPlugins: string[] = JSON.parse(
        localStorage.getItem(STORAGE_KEYS.ENABLED_PLUGINS) || "[]"
    );
    
    // Also filter the enabled-plugins list itself, since localStorage
    // is attacker-writable.
    const safeEnabled = enabledPlugins.filter(isSafeFileName);
    
    pluginsToLoad.forEach(plugin => {
        if (safeEnabled.includes(plugin)) {
            modController.loadPlugin(plugin);
        }
    });
}