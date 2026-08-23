import TemplateCache from '../../utils/templateCache';
import { MetaData } from '../../interfaces/MetaData';
import { escapeHtml, isSafeFileName } from '../../utils/sanitize';

export function getPluginItemTemplate(
    filename: string,
    metaData: MetaData,
    checked: boolean
): string {
    let template = TemplateCache.load(__dirname, 'plugin-item');

    // SECURITY: filename must be a safe leaf name; otherwise the
    // plugin UI list could be used as an oracle for path traversal
    // (e.g. setting a malicious attribute id).
    if (!isSafeFileName(filename)) {
        throw new Error(`Refusing to render plugin item for unsafe file name: ${filename}`);
    }

    // SECURITY: escape all metadata fields - they come from plugin
    // authors via the metadata block and could contain <script> etc.
    const safeMeta: Record<string, string> = {
        name: escapeHtml(metaData.name ?? ''),
        description: escapeHtml(metaData.description ?? ''),
        author: escapeHtml(metaData.author ?? ''),
        version: escapeHtml(metaData.version ?? ''),
    };

    const metaKeys = ['name', 'description', 'author', 'version'] as const;
    metaKeys.forEach(key => {
        const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
        template = template.replace(regex, safeMeta[key]);
    });

    return template
        .replace("{{ checked }}", checked ? "checked" : "")
        .replace(/\{\{\s*fileName\s*\}\}/g, escapeHtml(filename));
}
