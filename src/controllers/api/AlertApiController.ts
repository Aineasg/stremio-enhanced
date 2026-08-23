import { ipcMain } from 'electron';
import { ENHANCED_PLUGINS_API } from '../../constants';
import Helpers from '../../utils/Helpers';
import logger from '../../utils/logger';
import { clampString } from '../../utils/sanitize';

const MAX_ALERT_TEXT = 4096;
const MAX_BUTTONS = 6;
const VALID_ALERT_TYPES = new Set(['info', 'warning', 'error', 'question', 'none']);

export function setupPluginAlertAPI() {
    ipcMain.handle(ENHANCED_PLUGINS_API.SHOW_ALERT, async (_, alertType, title, message, buttons) => {
        // SECURITY: this handler is reachable from any plugin running
        // inside the renderer.  Cap every string field so a malicious
        // plugin can't DOS the dialog or write a 100MB message into
        // native win32 message boxes.
        if (typeof alertType !== 'string' || !VALID_ALERT_TYPES.has(alertType)) {
            logger.error(`Rejected alert: invalid alertType ${alertType}`);
            return -1;
        }
        if (typeof title !== 'string' || typeof message !== 'string') {
            logger.error('Rejected alert: title/message must be strings');
            return -1;
        }
        const safeTitle = clampString(title, MAX_ALERT_TEXT);
        const safeMessage = clampString(message, 32 * 1024);
        let safeButtons: string[];
        if (Array.isArray(buttons)) {
            safeButtons = buttons
                .filter((b: unknown): b is string => typeof b === 'string')
                .slice(0, MAX_BUTTONS)
                .map((b: string) => clampString(b, 64));
            if (safeButtons.length === 0) safeButtons = ['OK'];
        } else {
            safeButtons = ['OK'];
        }

        const response = await Helpers.showAlert(
            alertType as 'info' | 'warning' | 'error' | 'question' | 'none',
            safeTitle,
            safeMessage,
            safeButtons
        );
        return response;
    });
}
