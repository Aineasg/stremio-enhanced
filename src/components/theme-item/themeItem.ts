import TemplateCache from '../../utils/templateCache';
import { MetaData } from '../../interfaces/MetaData';
import { escapeHtml, isSafeFileName } from '../../utils/sanitize';

export function getThemeItemTemplate(
    filename: string,
    metaData: MetaData,
    applied: boolean
): string {
    let template = TemplateCache.load(__dirname, 'theme-item');

    if (!isSafeFileName(filename)) {
        throw new Error(`Refusing to render theme item for unsafe file name: ${filename}`);
    }

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
        .replace("{{ disabled }}", applied ? "disabled" : "")
        .replace(/\{\{\s*fileName\s*\}\}/g, escapeHtml(filename))
        .replace("{{ label }}", applied ? "Applied" : "Apply")
        .replace("{{ buttonClass }}", applied ? "uninstall-button-container-oV4Yo" : "install-button-container-yfcq5");
}
