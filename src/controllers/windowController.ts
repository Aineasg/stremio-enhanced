import { ipcMain } from 'electron';
import { IPC_CHANNELS } from "../constants";
import { mainWindow } from '../main';

const isWindows = process.platform === 'win32';

export function setupWindowControls() {
    ipcMain.on(IPC_CHANNELS.MINIMIZE_WINDOW, () => {
        mainWindow?.minimize();
    });
    
    ipcMain.on(IPC_CHANNELS.MAXIMIZE_WINDOW, () => {
        if (mainWindow) {
            if (mainWindow.isMaximized()) {
                mainWindow.unmaximize();
            } else {
                mainWindow.maximize();
            }
        }
    });

    ipcMain.handle(IPC_CHANNELS.IS_MAXIMIZED, () => {
        return mainWindow?.isMaximized() ?? false;
    });
    
    ipcMain.on(IPC_CHANNELS.CLOSE_WINDOW, () => {
        mainWindow?.close();
    });

    mainWindow?.on('maximize', () => {
        if (isWindows) mainWindow?.setResizable(false);
        mainWindow?.webContents.send(IPC_CHANNELS.WINDOW_MAXIMIZED, true);
    });

    mainWindow?.on('unmaximize', () => {
        if (isWindows) mainWindow?.setResizable(true);
        mainWindow?.webContents.send(IPC_CHANNELS.WINDOW_MAXIMIZED, false);
    });

    mainWindow?.on('enter-full-screen', () => {
        if (isWindows) mainWindow?.setResizable(false); 
        mainWindow?.webContents.send(IPC_CHANNELS.FULLSCREEN_CHANGED, true);
    });

    mainWindow?.on('leave-full-screen', () => {
        if (isWindows && !mainWindow?.isMaximized()) {
            mainWindow?.setResizable(true); 
        }
        
        mainWindow?.webContents.send(IPC_CHANNELS.FULLSCREEN_CHANGED, false);
    });

    ipcMain.on(IPC_CHANNELS.DRAG_WINDOW, (_, x: number, y: number) => {
        // SECURITY: x/y arrive from the renderer (any plugin can send
        // IPC).  Validate they are finite integers within a sane range
        // before moving the window, and never drag while maximized /
        // fullscreen (the renderer guards this too, but re-check here).
        if (!mainWindow) return;
        if (mainWindow.isMaximized() || mainWindow.isFullScreen()) return;
        if (typeof x !== 'number' || typeof y !== 'number') return;
        if (!Number.isInteger(x) || !Number.isInteger(y)) return;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000) return;
        mainWindow.setPosition(x, y);
    });
}