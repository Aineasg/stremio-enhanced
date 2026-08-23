import { readFileSync, statSync } from "fs";
import { join } from "path";
import Properties from "../core/Properties";
import { getLogger } from "./logger";
import { isSafeFileName } from "./sanitize";

const logger = getLogger("ThemeLoader");

/** Hard cap on a theme CSS file so a tampered file can't blow up the DOM. */
const MAX_THEME_CSS_BYTES = 8 * 1024 * 1024; // 8 MiB

/**
 * Apply a theme by reading its CSS in the preload context and injecting
 * it as a <style id="activeTheme"> element.
 *
 * WHY NOT <link href="file://...">?
 * With `webSecurity: true` (the hardened, correct setting) Chromium
 * blocks `file://` subresources on `https://` pages ("Not allowed to
 * load local resource"), so link-based theme loading silently fails.
 * Injecting the CSS text via <style> keeps themes working AND removes
 * the file:// URL surface entirely (a theme can no longer reference or
 * probe local resources through the stylesheet).
 *
 * @returns true when a non-default theme was applied.
 */
export function applyThemeStylesheet(themeName: string): boolean {
    document.getElementById("activeTheme")?.remove();

    if (themeName === "Default") return false;
    if (!isSafeFileName(themeName)) {
        logger.error(`Refusing to apply theme with unsafe name: ${JSON.stringify(themeName)}`);
        return false;
    }

    const themePath = join(Properties.themesPath, themeName);

    try {
        const stat = statSync(themePath);
        if (!stat.isFile()) {
            logger.error(`Theme is not a regular file: ${themeName}`);
            return false;
        }
        if (stat.size > MAX_THEME_CSS_BYTES) {
            logger.error(`Theme exceeds 8 MiB limit: ${themeName} (${stat.size} bytes)`);
            return false;
        }

        const css = readFileSync(themePath, "utf-8");
        if (css.length === 0) {
            logger.warn(`Theme file is empty: ${themeName}`);
            return false;
        }

        const styleElement = document.createElement("style");
        styleElement.id = "activeTheme";
        // textContent (never innerHTML) so the CSS is treated as pure
        // text data and cannot introduce markup into the page.
        styleElement.textContent = css;
        document.head.appendChild(styleElement);

        logger.info(`Theme applied: ${themeName}`);
        return true;
    } catch (err) {
        logger.error(`Failed to apply theme ${themeName}: ${(err as Error).message}`);
        return false;
    }
}
