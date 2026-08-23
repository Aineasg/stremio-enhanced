import TemplateCache from '../../utils/templateCache';
import { VALID_RENDERERS } from '../../interfaces/RendererTypes';
import { VALID_EXTERNAL_PLAYERS, type ExternalPlayer } from '../../interfaces/ExternalPlayerTypes';
import { escapeHtml } from '../../utils/sanitize';

export function getAboutCategoryTemplate(
    version: string,
    checkForUpdatesOnStartup: boolean,
    discordRichPresence: boolean,
    enableTransparentThemes: boolean,
    currentAngle: string,
    currentExternalPlayer: ExternalPlayer = 'disabled',
    vlcCustomPath: string = '',
    mpvCustomPath: string = ''
): string {
    let template = TemplateCache.load(__dirname, 'about-category');

    // SECURITY: version and custom paths can end up displayed in
    // attributes / text - escape them defensively.  version is read
    // from disk; vlc/mpv paths come from localStorage and are set by
    // the user via the input fields below.
    template = template
        .replace("{{ version }}", escapeHtml(version))
        .replace("{{ checkForUpdatesOnStartup }}", checkForUpdatesOnStartup ? "checked" : "")
        .replace("{{ discordrichpresence }}", discordRichPresence ? "checked" : "")
        .replace("{{ enableTransparentThemes }}", enableTransparentThemes ? "checked" : "")
        .replace("{{ disabled }}", process.platform == "darwin" ? "disabled" : "")
        .replace("{{ disabled_d3d11 }}", process.platform != "win32" ? "disabled" : "")
        .replace("{{ disabled_d3d9 }}", process.platform != "win32" ? "disabled" : "")

    VALID_RENDERERS.forEach(renderer => {
        const placeholder = `{{ selected_${renderer} }}`;
        const replacement = (currentAngle === renderer) ? "selected" : "";
        template = template.replace(placeholder, replacement);
    });

    VALID_EXTERNAL_PLAYERS.forEach(player => {
        const placeholder = `{{ selected_${player} }}`;
        const replacement = (currentExternalPlayer === player) ? "selected" : "";
        template = template.replace(placeholder, replacement);
    });

    template = template
        .replace('{{ vlc_path_display }}', currentExternalPlayer === 'vlc' ? '' : 'none')
        .replace('{{ mpv_path_display }}', currentExternalPlayer === 'mpv' ? '' : 'none')
        .replace('{{ vlc_custom_path }}', escapeHtml(vlcCustomPath))
        .replace('{{ mpv_custom_path }}', escapeHtml(mpvCustomPath));

    return template;
}