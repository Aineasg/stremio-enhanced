import * as net from 'net';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { resolve, isAbsolute, sep } from 'path';
import { getLogger } from '../utils/logger';
import { IPC_CHANNELS } from '../constants';
import { ipcMain, BrowserWindow } from 'electron';
import { VALID_EXTERNAL_PLAYERS, type ExternalPlayer } from '../interfaces/ExternalPlayerTypes';

const logger = getLogger("ExternalPlayerController");

// Common socket paths per platform
const MPV_SOCKET = process.platform === 'win32' ? '\\\\.\\pipe\\mpvsocket' : '/tmp/mpvsocket';
const VLC_HTTP_PORT = 9090;
const VLC_HTTP_PASSWORD = 'stremio';

// Common install paths per platform
const PLAYER_PATHS: Record<string, Record<string, string[]>> = {
    win32: {
        vlc: ['C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', 'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'],
        mpv: ['C:\\Program Files\\mpv\\mpv.exe', 'C:\\Program Files (x86)\\mpv\\mpv.exe'],
    },
    darwin: {
        vlc: ['/Applications/VLC.app/Contents/MacOS/VLC'],
        mpv: ['/usr/local/bin/mpv', '/opt/homebrew/bin/mpv'],
    },
    linux: {
        vlc: ['/usr/bin/vlc'],
        mpv: ['/usr/bin/mpv'],
    },
};

let pollInterval: ReturnType<typeof setInterval> | null = null;
let activeChild: ReturnType<typeof execFile> | null = null;

function findPlayerPath(player: 'vlc' | 'mpv'): string | null {
    const paths = PLAYER_PATHS[process.platform]?.[player] ?? [];
    return paths.find(p => existsSync(p)) ?? null;
}

async function getMpvStatus(): Promise<{ position: number; state: 'playing' | 'paused' } | null> {
    return new Promise((resolve) => {
        const socket = net.createConnection(MPV_SOCKET);
        const requests = [
            JSON.stringify({ command: ['get_property', 'time-pos'], request_id: 1 }),
            JSON.stringify({ command: ['get_property', 'pause'], request_id: 2 }),
        ];
        let resolved = false;
        let position: number | null = null;
        let paused: boolean | null = null;
        let buffer = '';

        const done = (val: { position: number; state: 'playing' | 'paused' } | null) => {
            if (!resolved) { resolved = true; resolve(val); socket.destroy(); }
        };

        const tryResolve = () => {
            if (position !== null && paused !== null)
                done({ position, state: paused ? 'paused' : 'playing' });
        };

        socket.on('connect', () => requests.forEach(r => socket.write(r + '\n')));
        socket.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const res = JSON.parse(line);
                    if (res.request_id === 1) position = res.data ?? null;
                    if (res.request_id === 2) paused = res.data ?? null;
                    tryResolve();
                } catch { /* ignore */ }
            }
        });
        socket.on('error', () => done(null));
        setTimeout(() => done(null), 1000);
    });
}

async function getVlcStatus(): Promise<{ position: number; state: 'playing' | 'paused' | 'stopped' } | null> {
    try {
        const auth = Buffer.from(`:${VLC_HTTP_PASSWORD}`).toString('base64');
        const res = await fetch(`http://localhost:${VLC_HTTP_PORT}/requests/status.json`, {
            headers: { Authorization: `Basic ${auth}` }
        });
        if (!res.ok) return null;
        const data = await res.json() as any;
        if (data.time == null || data.state == null) return null;
        return { position: data.time, state: data.state };
    } catch {
        return null;
    }
}

function startPolling(player: ExternalPlayer, child: ReturnType<typeof execFile>) {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(async () => {
        if (activeChild !== child) {
            clearInterval(pollInterval!);
            pollInterval = null;
            return;
        }

        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return;

        const status = player === 'mpv'
            ? await getMpvStatus()
            : await getVlcStatus();

        if (!status) return; // player not ready yet or temporarily unavailable, keep polling

        win.webContents.send(IPC_CHANNELS.EXTERNAL_PLAYER_POSITION, status);
    }, 5000);
}

/**
 * Validate that `customPath` is an absolute, normalized path to a file
 * we're allowed to execute.  This is permissive enough to accept the
 * user's custom VLC/MPV location but blocks relative paths, parent
 * traversal, and obviously malicious paths.
 *
 * Returns the resolved absolute path on success, or null on rejection.
 */
function validateCustomPlayerPath(customPath: string, expectedBasename: string): string | null {
    if (typeof customPath !== 'string' || customPath.length === 0) return null;
    if (customPath.length > 4096) return null;
    if (customPath.includes('\0')) return null;
    if (!isAbsolute(customPath)) return null;
    // Reject paths that try to traverse up.
    if (customPath.includes('..')) return null;
    let resolved: string;
    try {
        resolved = resolve(customPath);
    } catch {
        return null;
    }
    // Make sure the basename ends with the expected binary name (vlc/mpv
    // on Linux/macOS, vlc.exe/mpv.exe on Windows).  This blocks custom
    // paths that point to cmd.exe, powershell, /bin/sh, etc.
    const expected = process.platform === 'win32'
        ? `${expectedBasename}.exe`
        : expectedBasename;
    const base = resolved.split(sep).pop() ?? '';
    if (base.toLowerCase() !== expected.toLowerCase()) {
        return null;
    }
    if (!existsSync(resolved)) return null;
    return resolved;
}

/**
 * Validate that `streamUrl` is a sensible URL that the external player
 * is willing to open.  This blocks javascript:, file:, and very long
 * URLs that could be used to abuse the player as a confused-deputy.
 */
function validateStreamUrl(streamUrl: string): boolean {
    if (typeof streamUrl !== 'string') return false;
    if (streamUrl.length === 0 || streamUrl.length > 8192) return false;
    try {
        const u = new URL(streamUrl);
        return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'rtmp:' || u.protocol === 'rtsp:' || u.protocol === 'udp:' || u.protocol === 'rtp:';
    } catch {
        return false;
    }
}

export const externalPlayerController = {
    initIPC: () => {
        ipcMain.handle(IPC_CHANNELS.LAUNCH_EXTERNAL_PLAYER, (_, player: string, streamUrl: string, customPath?: string) => {
            if (!VALID_EXTERNAL_PLAYERS.includes(player as ExternalPlayer) || player === 'disabled') {
                logger.error(`Invalid external player: ${player}`);
                return { success: false, error: `Invalid player: ${player}` };
            }

            // SECURITY: validate stream URL before passing it to the
            // external binary.  Players like mpv / vlc accept URL-style
            // arguments, and we want to prevent any "javascript:" or
            // "file:" payloads from being interpreted.
            if (!validateStreamUrl(streamUrl)) {
                logger.error(`Refused to launch external player with unsafe stream URL: ${String(streamUrl).slice(0, 256)}`);
                return { success: false, error: 'Invalid stream URL.' };
            }

            const typedPlayer = player as 'vlc' | 'mpv';

            // SECURITY: if a custom path is supplied, validate it before
            // execFile.  Otherwise we'd be executing an arbitrary
            // user-supplied binary.
            let playerPath: string | null = null;
            if (customPath && typeof customPath === 'string') {
                playerPath = validateCustomPlayerPath(customPath, typedPlayer);
            }
            if (!playerPath) {
                playerPath = findPlayerPath(typedPlayer);
            }
            if (!playerPath) {
                logger.error(`${player} not found at any known path.`);
                return { success: false, error: `${player} not found. Please install it or set a custom path in settings.` };
            }

            // kill previous player if still running
            if (activeChild) {
                activeChild.kill();
            }
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
            }

            // SECURITY: the args array is passed to execFile (not exec),
            // so there is no shell to interpret.  We additionally make
            // sure `streamUrl` cannot start with `--` (argument
            // injection) by prefix-checking it.
            if (streamUrl.startsWith('--')) {
                logger.error('Refused to pass stream URL that looks like a CLI flag.');
                return { success: false, error: 'Stream URL rejected.' };
            }

            const args = typedPlayer === 'mpv'
                ? [streamUrl, `--input-ipc-server=${MPV_SOCKET}`]
                : [streamUrl, '--extraintf=http', `--http-password=${VLC_HTTP_PASSWORD}`, `--http-port=${VLC_HTTP_PORT}`];

            logger.info(`Launching ${player} at ${playerPath} with URL: ${streamUrl.slice(0, 128)}…`);

            const child = execFile(playerPath, args, (err) => {
                if (err) logger.error(`Failed to launch ${player}: ${err.message}`);
            });

            activeChild = child;

            child.on('exit', () => {
                // only handle exit if this is still the active child
                if (activeChild !== child) return;
                activeChild = null;
                if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
                const win = BrowserWindow.getAllWindows()[0];
                if (win) win.webContents.send(IPC_CHANNELS.EXTERNAL_PLAYER_CLOSED);
            });

            setTimeout(() => startPolling(typedPlayer as ExternalPlayer, child), 2000);

            return { success: true };
        });

        ipcMain.handle(IPC_CHANNELS.GET_EXTERNAL_PLAYER_PATHS, () => ({
            vlc: findPlayerPath('vlc'),
            mpv: findPlayerPath('mpv'),
        }));
    }
};
