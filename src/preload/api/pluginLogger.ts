import { getLogger } from '../../utils/logger';

/**
 * SECURITY: these functions are exposed to the page (and therefore to
 * every plugin) via contextBridge.  Without clamping, a malicious
 * plugin could write unbounded strings into the main-process log
 * (memory / log-file exhaustion) or inject ANSI escape sequences /
 * fake log lines (log forging).  Clamp the length and strip control
 * characters (including ESC) from both the plugin name and message.
 */
const MAX_LOG_PLUGIN_NAME = 128;
const MAX_LOG_MESSAGE = 4000;

function sanitizeLogPart(value: unknown, max: number): string {
    if (typeof value !== 'string') return '';
    return value
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
        .slice(0, max);
}

function log(pluginName: unknown, message: unknown, level: 'info' | 'warn' | 'error'): void {
    const logger = getLogger(sanitizeLogPart(pluginName, MAX_LOG_PLUGIN_NAME));
    logger[level](sanitizeLogPart(message, MAX_LOG_MESSAGE));
}

export const pluginLogger = {
    info: (pluginName: string, message: string) => log(pluginName, message, 'info'),

    warn: (pluginName: string, message: string) => log(pluginName, message, 'warn'),

    error: (pluginName: string, message: string) => log(pluginName, message, 'error')
};
