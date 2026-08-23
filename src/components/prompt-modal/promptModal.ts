import TemplateCache from '../../utils/templateCache';
import { escapeHtml } from '../../utils/sanitize';

export function getPromptModalTemplate(
    promptId: string,
    title: string,
    message: string,
    defaultValue?: string
): string {
    // SECURITY: promptId, title, message, defaultValue can all be
    // plugin-supplied (via StremioEnhancedAPI.showPrompt).  Escape
    // every value before interpolating into HTML to prevent XSS.
    const safeId = escapeHtml(promptId);
    const modalId = `prompt-modal-${safeId}`;

    const html = TemplateCache.load(__dirname, 'prompt-modal')
        .replace(/\{\{\s*modalId\s*\}\}/g, modalId)
        .replace(/\{\{\s*title\s*\}\}/g, escapeHtml(title))
        .replace(/\{\{\s*message\s*\}\}/g, escapeHtml(message))
        .replace(/\{\{\s*defaultValue\s*\}\}/g, escapeHtml(defaultValue ?? ""));

    return html;
}
