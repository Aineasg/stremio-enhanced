import { app, ipcMain } from 'electron';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getLogger } from '../utils/logger';
import { IPC_CHANNELS } from '../constants';
import { Renderer, VALID_RENDERERS } from "../interfaces/RendererTypes";

const logger = getLogger("GPUController");

export const gpuController = {
    setup: (userDataPath: string) => {
        // NOTE: 'disable-features' is intentionally NOT appended here.
        // Chromium keeps only the last value of a duplicated switch, so
        // appending it again would silently discard the values set in
        // main.ts (PNA overrides + UseChromeOSDirectVideoDecoder).  The
        // combined value lives in main.ts - add new disabled features
        // there.

        let enabledFeatures = [
            'PlatformHEVCDecoderSupport',
            'AudioVideoTracks'
        ];

        const bootConfigPath = join(userDataPath, 'boot-config.json');
        let userRenderer: string = 'auto';  // 'auto', 'd3d11', 'd3d9', 'gl', 'vulkan', 'software'

        if (existsSync(bootConfigPath)) {
            try {
                const config = JSON.parse(readFileSync(bootConfigPath, 'utf-8'));
                if (config.renderer) userRenderer = config.renderer;
            } catch (e) {
                logger.error("Failed to read boot config.");
            }
        }

        if (userRenderer === 'software') {
            logger.warn("User forced Software Rendering.");
            app.disableHardwareAcceleration();
            return;
        } else if(process.platform !== "darwin") { 
            // if not using software rendering and not on macOS, enable GPU related features
            logger.info("Enabling GPU features");
            enabledFeatures.push("AcceleratedVideoEncoder");
            enabledFeatures.push("disable-gpu-driver-bug-workaround");
            app.commandLine.appendSwitch('ignore-gpu-blocklist');
            app.commandLine.appendSwitch('enable-zero-copy');
            app.commandLine.appendSwitch('enable-gpu-rasterization');
            app.commandLine.appendSwitch('enable-accelerated-video-decode');
        }

        if (process.platform === 'darwin') {
            // logger.info('Running on macOS, forcing Metal');
            // app.commandLine.appendSwitch('use-angle', 'metal');
            enabledFeatures.push("VideoToolboxVideoDecoder");
        } else if (process.platform === 'win32') {
            const renderer = userRenderer === 'auto' ? 'd3d11' : userRenderer;
            logger.info(`Running on Windows, using ${renderer}`);

            app.commandLine.appendSwitch('use-angle', renderer);
            app.commandLine.appendSwitch('enable-gpu-rasterization');
            app.commandLine.appendSwitch('use-gl', 'angle');

            if (userRenderer === 'd3d11' || userRenderer === 'auto') enabledFeatures.push('D3D11VideoDecoder');
        } else {
            const renderer = userRenderer === 'auto' ? 'gl' : userRenderer;
            logger.info(`Running on Linux, using ${renderer}`);

            app.commandLine.appendSwitch('use-angle', renderer);
            app.commandLine.appendSwitch('enable-gpu-rasterization');

            if (renderer === 'vulkan') {
                enabledFeatures.push(
                    'Vulkan',
                    'VaapiVideoDecoder',
                    'VaapiIgnoreDriverChecks',
                    'CanvasOopRasterization'
                );
            } else {
                enabledFeatures.push(
                    'VaapiVideoDecoder',
                    'VaapiVideoDecodeLinuxGL',
                    'CanvasOopRasterization'
                );
            }
        }

        app.commandLine.appendSwitch('enable-features', enabledFeatures.join(','));

        logger.info(`GPU setup complete. Renderer set to: ${userRenderer}, Hardware Acceleration: ${app.isHardwareAccelerationEnabled() ? 'Enabled' : 'Disabled'}, Features: ${enabledFeatures.join(', ')}`);
    },

    initIPC: (userDataPath: string) => {
        const bootConfigPath = join(userDataPath, 'boot-config.json');

        ipcMain.handle(IPC_CHANNELS.SET_GPU_RENDERER, (_, selectedRenderer: string) => {
            // SECURITY: validate the renderer against the fixed
            // allowlist.  Anything else is rejected so a malicious
            // renderer / plugin can't write arbitrary strings into the
            // boot config that later get concatenated into chromium
            // command-line switches.
            if (typeof selectedRenderer !== 'string' ||
                !VALID_RENDERERS.includes(selectedRenderer as Renderer)) {
                logger.error(`Rejected GPU renderer '${String(selectedRenderer)}' - not in allowlist.`);
                return false;
            }

            let config: { renderer: string } = { renderer: 'auto' };

            if (existsSync(bootConfigPath)) {
                try {
                    const existingConfig = JSON.parse(readFileSync(bootConfigPath, 'utf-8'));
                    // Only copy known keys - prevents prototype pollution.
                    if (existingConfig && typeof existingConfig === 'object' && !Array.isArray(existingConfig)) {
                        config = { ...config, renderer: existingConfig.renderer ?? 'auto' };
                    }
                } catch (e) {
                    logger.error("Failed to parse existing boot config during update.");
                }
            }

            config.renderer = selectedRenderer;
            writeFileSync(bootConfigPath, JSON.stringify(config, null, 2));
            
            logger.info(`User updated GPU renderer to: ${selectedRenderer}. Requires restart.`);
            return true;
        });

        ipcMain.handle(IPC_CHANNELS.GET_GPU_RENDERER, (): Renderer => {
            if (!existsSync(bootConfigPath)) {
                writeFileSync(bootConfigPath, JSON.stringify({ renderer: "auto" }, null, 2));
                return "auto";
            }

            try {
                const rawData = readFileSync(bootConfigPath, 'utf-8');
                const configFile = JSON.parse(rawData);
                const savedRenderer = configFile?.renderer;

                if (VALID_RENDERERS.includes(savedRenderer as Renderer)) {
                    return savedRenderer as Renderer;
                } else {
                    logger.warn(`Invalid renderer '${savedRenderer}' found in config. Defaulting to auto.`);
                    return "auto";
                }
            } catch (error) {
                logger.error(`Failed to read/parse boot config: ${(error as Error).message}`);
                return "auto"; 
            }
        });
    }
}