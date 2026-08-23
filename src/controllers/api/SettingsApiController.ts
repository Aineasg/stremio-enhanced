import { ipcMain } from 'electron';
import PluginOption from '../../interfaces/PluginSettingSchema';
import { ENHANCED_PLUGINS_API, FILE_EXTENSIONS } from '../../constants';
import Properties from '../../core/Properties';
import logger from '../../utils/logger';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { safeJoin, isSafeFileName, clampString } from '../../utils/sanitize';

const registeredPluginSchemas: Record<string, PluginOption[]> = {};

const MAX_SCHEMA_SIZE = 256 * 1024; // 256 KiB - plugins shouldn't ship huge schemas
const MAX_SETTING_KEY_LEN = 128;
const MAX_SETTING_VALUE_LEN = 1 * 1024 * 1024; // 1 MiB upper bound for a single value

/**
 * Build the absolute path of `<pluginsPath>/<pluginFileName>.plugin.json`
 * while rejecting any name that tries to escape the plugins directory.
 *
 * `pluginFileName` arrives from the renderer / from plugin code that
 * has been loaded into the page.  Without this check a malicious plugin
 * could send `../../etc/passwd` and have the main process read/write
 * arbitrary files.
 */
function resolvePluginConfigPath(pluginFileName: string): string {
    if (!isSafeFileName(pluginFileName)) {
        throw new Error(`Unsafe plugin file name: ${JSON.stringify(pluginFileName)}`);
    }
    return safeJoin(Properties.pluginsPath, `${pluginFileName}${FILE_EXTENSIONS.PLUGIN_CONFIG}`);
}

function resolvePluginFilePath(pluginFileName: string): string {
    if (!isSafeFileName(pluginFileName)) {
        throw new Error(`Unsafe plugin file name: ${JSON.stringify(pluginFileName)}`);
    }
    return safeJoin(Properties.pluginsPath, `${pluginFileName}${FILE_EXTENSIONS.PLUGIN}`);
}

/** Defensive JSON parser that catches prototype-pollution payloads. */
function safeJsonParse(text: string): Record<string, unknown> {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
    }
    // Strip any keys that could touch Object.prototype.
    return JSON.parse(JSON.stringify(parsed)); // decouples __proto__
}

export function setupPluginSettingsAPI() {
    ipcMain.handle(ENHANCED_PLUGINS_API.GET_SETTING, (_, pluginFileName, key) => {
        if (typeof pluginFileName !== 'string' || typeof key !== 'string') {
            return Promise.reject(new Error('Invalid arguments'));
        }
        if (key.length > MAX_SETTING_KEY_LEN) {
            return Promise.reject(new Error('Setting key too long'));
        }

        let configPath: string;
        try {
            configPath = resolvePluginConfigPath(pluginFileName);
        } catch (err) {
            logger.error(`Rejected get-setting path: ${(err as Error).message}`);
            return Promise.reject(new Error('Invalid plugin file name'));
        }

        if (!existsSync(configPath)) {
            logger.warn(`No config found for plugin ${pluginFileName}`);
            try {
                writeFileSync(configPath, '{}', { encoding: 'utf-8' });
            } catch (err) {
                logger.error(`Failed to create config: ${(err as Error).message}`);
            }
            return Promise.reject(new Error(`No config found (${pluginFileName}${FILE_EXTENSIONS.PLUGIN_CONFIG})!`));
        }

        try {
            const readConfig = readFileSync(configPath, 'utf-8');
            const jsonConfig = safeJsonParse(readConfig);
            return (jsonConfig as Record<string, unknown>)[key] ?? null;
        } catch (err) {
            logger.error(`Failed to read config for ${pluginFileName}: ${(err as Error).message}`);
            return Promise.reject(new Error('Failed to read config'));
        }
    });

    ipcMain.handle(ENHANCED_PLUGINS_API.GET_SETTINGS, (_, pluginFileName) => {
        if (typeof pluginFileName !== 'string') {
            return Promise.reject(new Error('Invalid arguments'));
        }

        let configPath: string;
        try {
            configPath = resolvePluginConfigPath(pluginFileName);
        } catch (err) {
            logger.error(`Rejected get-settings path: ${(err as Error).message}`);
            return Promise.reject(new Error('Invalid plugin file name'));
        }

        if (!existsSync(configPath)) {
            logger.warn(`No config found for plugin ${pluginFileName}`);
            try {
                writeFileSync(configPath, '{}', { encoding: 'utf-8' });
            } catch (err) {
                logger.error(`Failed to create config: ${(err as Error).message}`);
            }
            return Promise.reject(new Error(`No config found (${pluginFileName}${FILE_EXTENSIONS.PLUGIN_CONFIG})!`));
        }

        try {
            const readConfig = readFileSync(configPath, 'utf-8');
            return safeJsonParse(readConfig);
        } catch (err) {
            logger.error(`Failed to read config for ${pluginFileName}: ${(err as Error).message}`);
            return Promise.reject(new Error('Failed to read config'));
        }
    });

    ipcMain.handle(ENHANCED_PLUGINS_API.SAVE_SETTING, (event, pluginFileName, key, value) => {
        if (typeof pluginFileName !== 'string' || typeof key !== 'string') {
            logger.error('Rejected save-setting: invalid argument types');
            return false;
        }
        if (key.length > MAX_SETTING_KEY_LEN) {
            logger.error('Rejected save-setting: key too long');
            return false;
        }
        // Reject prototype-pollution keys outright.
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
            logger.error(`Rejected save-setting: forbidden key ${key}`);
            return false;
        }
        // Bound the size of any persisted value.
        try {
            const serialized = JSON.stringify(value);
            if (serialized.length > MAX_SETTING_VALUE_LEN) {
                logger.error('Rejected save-setting: value too large');
                return false;
            }
        } catch {
            logger.error('Rejected save-setting: value is not JSON-serializable');
            return false;
        }

        let configPath: string;
        try {
            configPath = resolvePluginConfigPath(pluginFileName);
        } catch (err) {
            logger.error(`Rejected save-setting path: ${(err as Error).message}`);
            return false;
        }

        if (!existsSync(configPath)) {
            logger.info(`No config found for plugin ${pluginFileName}. Creating new config file with setting ${key}.`);
            try {
                writeFileSync(configPath, '{}', { encoding: 'utf-8' });
            } catch (err) {
                logger.error(`Failed to create config: ${(err as Error).message}`);
                return false;
            }
        }

        try {
            const readConfig = readFileSync(configPath, 'utf-8');
            const jsonConfig = safeJsonParse(readConfig);
            (jsonConfig as Record<string, unknown>)[key] = value;
            writeFileSync(configPath, JSON.stringify(jsonConfig, null, 2), { encoding: 'utf-8' });

            const channel = `${ENHANCED_PLUGINS_API.ON_SETTINGS_SAVED}:${pluginFileName}`;
            event.sender.send(channel, jsonConfig);
            return true;
        } catch (err) {
            logger.error(`Failed to save setting for ${pluginFileName}: ${(err as Error).message}`);
            return false;
        }
    });

    ipcMain.handle(ENHANCED_PLUGINS_API.REGISTER_SETTINGS, (_, pluginFileName, pluginSchema) => {
        if (typeof pluginFileName !== 'string' || !Array.isArray(pluginSchema)) {
            logger.error("Invalid plugin options schema received. Expected an array of options.");
            return Promise.reject(new Error("Invalid plugin options schema. Ensure it follows the correct structure."));
        }

        if (JSON.stringify(pluginSchema).length > MAX_SCHEMA_SIZE) {
            logger.error("Plugin schema too large; rejecting registration.");
            return Promise.reject(new Error("Plugin schema too large."));
        }

        let pluginPath: string;
        try {
            pluginPath = resolvePluginFilePath(pluginFileName);
        } catch (err) {
            logger.error(`Rejected register-settings path: ${(err as Error).message}`);
            return Promise.reject(new Error('Invalid plugin file name'));
        }
        if (!existsSync(pluginPath)) {
            logger.error(`Plugin file not found for registering options: ${pluginFileName}${FILE_EXTENSIONS.PLUGIN}`);
            return Promise.reject(new Error("Plugin file not found."));
        }

        let configPath: string;
        try {
            configPath = resolvePluginConfigPath(pluginFileName);
        } catch (err) {
            logger.error(`Rejected register-settings config path: ${(err as Error).message}`);
            return Promise.reject(new Error('Invalid plugin file name'));
        }
        if (!existsSync(configPath)) {
            logger.info(`No config found for plugin ${pluginFileName}. Creating new config file.`);
            try {
                writeFileSync(configPath, '{}', { encoding: 'utf-8' });
            } catch (err) {
                logger.error(`Failed to create config: ${(err as Error).message}`);
                return Promise.reject(new Error('Failed to create config'));
            }
        }
        
        if (registeredPluginSchemas[pluginFileName]) {
            return Promise.reject(`Plugin ${pluginFileName} already has a settings schema registered!`);
        }

        // Clamp each schema entry defensively so a malicious plugin
        // can't ship 1 MB strings just to bloat the UI / log files.
        const sanitizedSchema: PluginOption[] = pluginSchema.map((entry: any) => ({
            key: clampString(entry?.key, MAX_SETTING_KEY_LEN),
            label: clampString(entry?.label, 1024),
            type: ['input', 'toggle', 'select'].includes(entry?.type) ? entry.type : 'input',
            description: typeof entry?.description === 'string' ? clampString(entry.description, 4096) : undefined,
            defaultValue: entry?.defaultValue,
            options: Array.isArray(entry?.options)
                ? entry.options.map((o: any) => ({ label: clampString(o?.label, 256), value: o?.value }))
                : undefined,
        })) as PluginOption[];

        registeredPluginSchemas[pluginFileName] = sanitizedSchema;
        logger.info(`Registered options for plugin ${pluginFileName} (${sanitizedSchema.length} entries).`);
        return true;
    });

    ipcMain.handle(ENHANCED_PLUGINS_API.CLEAR_REGISTERED_SETTINGS, (_, pluginFileName) => {
        if (typeof pluginFileName !== 'string') return false;
        if (registeredPluginSchemas[pluginFileName]) {
            delete registeredPluginSchemas[pluginFileName];
            return true;
        }
        return false;
    });

    ipcMain.handle(ENHANCED_PLUGINS_API.GET_REGISTERED_SETTINGS, (_, pluginFileName) => {
        if (typeof pluginFileName !== 'string') {
            logger.error("Invalid plugin file name received for getting options.");
            return Promise.reject("Invalid plugin file name.");
        }
        return registeredPluginSchemas[pluginFileName] || null;
    });
}
