import TemplateCache from "../../utils/templateCache";
import { escapeHtml } from "../../utils/sanitize";

export async function getToastTemplate(id: string, title: string, message: string, status: "success" | "fail" | "info"): Promise<string> {
    let template = TemplateCache.load(__dirname, 'toast');
    let toastStatus;

    switch(status) {
        case "success":
            toastStatus = "success-eIDTa";
            break;
        case "fail":
            toastStatus = "error-quyOd";
            break;
        case "info":
            toastStatus = "info-KEWq8";
            break;
    }
    
    // SECURITY: id, title, message can be plugin-supplied.
    // Escape all dynamic text and the id attribute to prevent XSS
    // via toast notifications.
    return template
        .replace("{{ id }}", escapeHtml(id))
        .replace("{{ title }}", escapeHtml(title))
        .replace("{{ message }}", escapeHtml(message))
        .replace("{{ status }}", escapeHtml(toastStatus));
}
