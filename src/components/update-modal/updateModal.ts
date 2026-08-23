import { marked } from "marked";
import TemplateCache from "../../utils/templateCache";
import Updater from "../../core/Updater";
import { escapeHtml } from "../../utils/sanitize";

export async function getUpdateModalTemplate(currentVersion: string, latestVersion: string): Promise<string> {
    let template = TemplateCache.load(__dirname, 'update-modal');
    
    const releaseNotes = await Updater.getReleaseNotes();

    // SECURITY: `marked` renders arbitrary HTML by default, which
    // would be XSS if a malicious release body contains <script> tags.
    // Post-process the rendered HTML by stripping any <script>,
    // <iframe>, inline event handlers, and javascript: URLs that may
    // have slipped through.
    const markdown = (await marked.parse(releaseNotes, { gfm: true, breaks: true, async: false })) as string;

    const sanitizedMarkdown = markdown
        // Remove script / iframe / object / embed tags entirely.
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
        .replace(/<object[\s\S]*?<\/object>/gi, '')
        .replace(/<embed[\s\S]*?(\/?>)/gi, '')
        // Strip inline event handlers (onclick=, onload=, etc).
        .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        // Strip javascript: URLs in href/src attributes.
        .replace(/(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, '$1="#"');

    return template
        .replace("{{ releaseNotes }}", sanitizedMarkdown)
        .replace(/\{\{\s*currentVersion\s*\}\}/g, escapeHtml(currentVersion))
        .replace(/\{\{\s*newVersion\s*\}\}/g, escapeHtml(latestVersion));
}
