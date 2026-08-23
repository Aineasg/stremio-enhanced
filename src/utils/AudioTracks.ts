import Helpers from "./Helpers";
import { getLogger } from "./logger";
import { escapeHtml } from "./sanitize";

const logger = getLogger("AudioTracks");

class AudioTracks {
    private static detectedAlready = false;
    private static menuElement: HTMLElement | null = null;
    private static closeHandler: ((e: MouseEvent) => void) | null = null;
    private static switching = false;

    public static async checkWatching() {
        if (!location.href.includes('#/player')) {
            this.detectedAlready = false;
            this.closeMenu();
            return;
        }

        await Helpers.waitForElm('video');
        const video = document.querySelector("video") as HTMLVideoElement;
        if (!video) return;

        // FIX (race condition): if metadata is already loaded by the time
        // we attach (fast loads / SPA navigation inside the player), the
        // loadedmetadata event will never fire for us and the audio
        // button stayed permanently grayed out. Detect immediately when
        // readyState already has metadata.
        if (video.readyState >= 1) {
            this.detectTracks(video);
            return;
        }

        video.addEventListener("loadedmetadata", () => this.detectTracks(video));
    }

    private static detectTracks(video: HTMLVideoElement): void {
        if (this.detectedAlready) return;

        const audioTracks = (video as any).audioTracks;
        if (!audioTracks) {
            logger.warn("video.audioTracks is unavailable yet (AudioVideoTracks feature not active?) - retrying...");
            this.retryDetection(video, 1);
            return;
        }

        // HLS multi-audio manifests are sometimes parsed slightly
        // after loadedmetadata - re-check a few times before giving
        // up so we don't miss tracks on slow loads.
        if (audioTracks.length <= 1) {
            logger.info(`Only ${audioTracks.length} audio track(s) visible at loadedmetadata; retrying...`);
            this.retryDetection(video, 1);
            return;
        }

        this.detectedAlready = true;
        const langs: string[] = [];
        for (let i = 0; i < audioTracks.length; i++) {
            langs.push(audioTracks[i].language || "und");
        }
        logger.info(`Found ${audioTracks.length} native audio tracks: ${langs.join(", ")}`);
        this.enableAudioButton(audioTracks);
    }

    private static retryDetection(video: HTMLVideoElement, attempt: number): void {
        if (this.detectedAlready) return;
        const audioTracks = (video as any).audioTracks;
        if (audioTracks && audioTracks.length > 1) {
            this.detectedAlready = true;
            const langs: string[] = [];
            for (let i = 0; i < audioTracks.length; i++) {
                langs.push(audioTracks[i].language || "und");
            }
            logger.info(`Found ${audioTracks.length} native audio tracks on retry ${attempt}: ${langs.join(", ")}`);
            this.enableAudioButton(audioTracks);
            return;
        }
        if (attempt >= 8) {
            this.detectedAlready = true;
            logger.info(`No multiple audio tracks after ${attempt} checks (${audioTracks?.length ?? 0}). The stream likely has a single audio track, or the backend does not expose multi-audio HLS.`);
            return;
        }
        setTimeout(() => this.retryDetection(video, attempt + 1), 1000);
    }

    private static async enableAudioButton(audioTracks: any) {
        // The control bar renders some time after the video element -
        // wait for it before looking for the audio button.
        try {
            await Helpers.waitForElm('[class*="control-bar-button"]', 15000);
        } catch {
            logger.warn("Control bar not found; cannot attach audio menu entry.");
            return;
        }

        const knownAudioSvgPrefixes = ['M57.48', 'M57,', 'M56', 'M58'];
        const allButtons = document.querySelectorAll('[class*="control-bar-button"]');
        let audioButton: Element | null = null;

        // 1) Preferred: Stremio's own audio button, identified by its
        //    speaker-icon SVG path prefix - regardless of whether it is
        //    currently marked disabled or hidden.
        for (const btn of Array.from(allButtons)) {
            for (const path of Array.from(btn.querySelectorAll('path'))) {
                const d = path.getAttribute('d') || '';
                if (knownAudioSvgPrefixes.some(prefix => d.startsWith(prefix))) {
                    audioButton = btn;
                    break;
                }
            }
            if (audioButton) break;
        }

        // 2) Legacy heuristic: the last disabled single-path button in
        //    the control bar (the old behaviour).
        if (!audioButton) {
            const disabledButtons = document.querySelectorAll('[class*="control-bar-button"][class*="disabled"]');
            for (let i = disabledButtons.length - 1; i >= 0; i--) {
                if (disabledButtons[i].querySelectorAll('path').length === 1) {
                    audioButton = disabledButtons[i];
                    break;
                }
            }
        }

        if (audioButton) {
            audioButton.className = audioButton.className.replace(/\bdisabled\b/g, '').trim();
            // In case the button is hidden rather than disabled.
            (audioButton as HTMLElement).style.display = '';
            audioButton.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.toggleMenu(audioTracks);
            });
            logger.info("Audio track button enabled (native Stremio button).");
            return;
        }

        // 3) Last resort: Stremio Web's markup changed enough that we
        //    can't find their audio button - inject our own, styled to
        //    match its neighbours, so language switching keeps working
        //    across Stremio Web UI updates.
        this.injectOwnAudioButton(audioTracks);
    }

    /**
     * Inject our own audio-tracks button into the player control bar.
     * Used when Stremio Web's own audio button can't be identified
     * (their UI/markup changes independently of this app).
     */
    private static injectOwnAudioButton(audioTracks: any): void {
        if (document.getElementById('enhanced-audio-btn')) return;

        const buttons = document.querySelectorAll('[class*="control-bar-button"]');
        if (buttons.length === 0) {
            logger.warn("No control bar buttons found to anchor our audio button.");
            return;
        }

        const anchor = buttons[buttons.length - 1] as HTMLElement;
        const btn = document.createElement('div');
        btn.id = 'enhanced-audio-btn';
        // Copy a working sibling's classes so it inherits Stremio's
        // button styling (minus any disabled state).
        btn.className = anchor.className.replace(/\bdisabled\b/g, '').trim();
        btn.setAttribute('tabindex', '0');
        btn.setAttribute('title', 'Audio tracks');
        btn.setAttribute('aria-label', 'Audio tracks');
        btn.style.cursor = 'pointer';
        btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" style="fill: currentcolor;"></path></svg>`;

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.toggleMenu(audioTracks);
        });

        anchor.after(btn);
        logger.info("Injected custom audio track button into the control bar.");
    }

    private static injectStyles() {
        if (document.getElementById('enhanced-audio-menu-styles')) return;

        const style = document.createElement('style');
        style.id = 'enhanced-audio-menu-styles';
        style.textContent = `
            .enhanced-audio-menu-layer {
                position: absolute;
                top: initial;
                left: initial;
                right: 4rem;
                bottom: 8rem;
                max-height: calc(100% - 13.5rem);
                max-width: calc(100% - 4rem);
                border-radius: var(--border-radius);
                background-color: var(--modal-background-color);
                box-shadow: 0 1.35rem 2.7rem rgba(0,0,0,0.4),
                    0 1.1rem 0.85rem rgba(0,0,0,0.2);
                backdrop-filter: blur(15px);
                overflow: auto;
                z-index: 1;
            }
            .enhanced-audio-menu {
                display: flex;
                flex-direction: row;
            }
            .enhanced-audio-menu .eam-container {
                flex: none;
                align-self: stretch;
                display: flex;
                flex-direction: column;
                max-height: 25rem;
                width: 16rem;
            }
            .enhanced-audio-menu .eam-header {
                flex: none;
                align-self: stretch;
                padding: 1.5rem 2rem;
                font-weight: 700;
                color: var(--primary-foreground-color);
            }
            .enhanced-audio-menu .eam-list {
                flex: 1;
                align-self: stretch;
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                overflow-y: auto;
                padding: 0 1rem;
                padding-bottom: 1rem;
            }
            .enhanced-audio-menu .eam-option {
                flex: none;
                display: flex;
                flex-direction: row;
                align-items: center;
                gap: 1rem;
                height: 4rem;
                padding: 0 1.5rem;
                border-radius: var(--border-radius);
                cursor: pointer;
                border: none;
                background: none;
                text-align: left;
                width: 100%;
                box-sizing: border-box;
            }
            .enhanced-audio-menu .eam-option:hover,
            .enhanced-audio-menu .eam-option.selected {
                background-color: var(--overlay-color);
            }
            .enhanced-audio-menu .eam-info {
                flex: 1;
                display: flex;
                flex-direction: column;
                gap: 0.25rem;
            }
            .enhanced-audio-menu .eam-lang {
                flex: auto;
                white-space: nowrap;
                text-overflow: ellipsis;
                font-size: 1.1rem;
                line-height: 1.5rem;
                color: var(--primary-foreground-color);
            }
            .enhanced-audio-menu .eam-label {
                flex: auto;
                white-space: nowrap;
                text-overflow: ellipsis;
                font-size: 0.9rem;
                color: var(--color-placeholder-text, rgba(255,255,255,0.5));
            }
            .enhanced-audio-menu .eam-icon {
                flex: none;
                width: 0.5rem;
                height: 0.5rem;
                border-radius: 100%;
                background-color: var(--secondary-accent-color);
            }
        `;
        document.head.appendChild(style);
    }

    private static toggleMenu(audioTracks: any) {
        if (this.menuElement) {
            this.closeMenu();
            return;
        }

        this.injectStyles();

        // Find the player container to attach the menu to (same as Stremio's menu-layer)
        const playerContainer = document.querySelector('[class*="player-container"]');
        if (!playerContainer) {
            logger.info("Could not find player container.");
            return;
        }

        const menu = document.createElement('div');
        menu.className = 'enhanced-audio-menu-layer';
        menu.addEventListener('mousedown', (e) => {
            // Prevent menu from closing when clicking inside
            e.stopPropagation();
        });

        let selectedId: string | null = null;
        for (let i = 0; i < audioTracks.length; i++) {
            if (audioTracks[i].enabled) {
                selectedId = audioTracks[i].id;
                break;
            }
        }

        let menuHTML = `<div class="enhanced-audio-menu"><div class="eam-container">`;
        menuHTML += `<div class="eam-header">Audio tracks</div>`;
        menuHTML += `<div class="eam-list">`;

        for (let i = 0; i < audioTracks.length; i++) {
            const track = audioTracks[i];
            const langName = this.getLanguageName(track.language);
            const isSelected = track.id === selectedId;

            menuHTML += `<div class="eam-option${isSelected ? ' selected' : ''}" data-index="${i}" title="${escapeHtml(track.label || langName)}">`;
            menuHTML += `<div class="eam-info">`;
            menuHTML += `<div class="eam-lang">${escapeHtml(langName)}</div>`;
            menuHTML += `<div class="eam-label">${escapeHtml(track.label || track.language || '')}</div>`;
            menuHTML += `</div>`;
            if (isSelected) {
                menuHTML += `<div class="eam-icon"></div>`;
            }
            menuHTML += `</div>`;
        }

        menuHTML += `</div></div></div>`;
        menu.innerHTML = menuHTML;

        // Add click handlers to each option
        menu.querySelectorAll('.eam-option').forEach((option) => {
            option.addEventListener('click', () => {
                if (this.switching) return;

                const index = parseInt(option.getAttribute('data-index') || '0');
                if (audioTracks[index].enabled) {
                    this.closeMenu();
                    return;
                }

                this.switching = true;
                for (let j = 0; j < audioTracks.length; j++) {
                    audioTracks[j].enabled = (j === index);
                }
                const langName = this.getLanguageName(audioTracks[index].language);
                logger.info(`Switched to audio track ${index}: ${audioTracks[index].language}`);
                this.closeMenu();
                Helpers.createToast("audioTrackSwitched", "Audio track changed",
                    `Now playing: ${langName}`, "success");

                // Cooldown to let the browser settle before allowing another switch
                setTimeout(() => { this.switching = false; }, 1000);
            });
        });

        playerContainer.appendChild(menu);
        this.menuElement = menu;

        // Close menu when clicking outside
        this.closeHandler = (e: MouseEvent) => {
            if (!this.menuElement?.contains(e.target as Node)) {
                this.closeMenu();
            }
        };
        setTimeout(() => document.addEventListener('mousedown', this.closeHandler!), 0);
    }

    private static closeMenu() {
        if (this.menuElement) {
            this.menuElement.remove();
            this.menuElement = null;
        }
        if (this.closeHandler) {
            document.removeEventListener('mousedown', this.closeHandler);
            this.closeHandler = null;
        }
    }

    private static getLanguageName(code: string): string {
        if (!code || code.toLowerCase() === 'und') {
            return 'Unknown';
        }

        try {
            const userLocale = navigator.language || 'en';
            const displayNames = new Intl.DisplayNames([userLocale], { type: 'language' });
            const name = displayNames.of(code);
            
            return name ? name.charAt(0).toUpperCase() + name.slice(1) : code.toUpperCase();
        } catch (error) {
            logger.warn(`Could not resolve language name for code: ${code}`);
            return code.toUpperCase();
        }
    }
}

export default AudioTracks;
