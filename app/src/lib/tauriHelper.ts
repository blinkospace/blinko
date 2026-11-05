import { platform } from '@tauri-apps/plugin-os'
import { BaseDirectory } from '@tauri-apps/plugin-fs'
import { save } from '@tauri-apps/plugin-dialog'
import { helper } from './helper'
import { RootStore } from '@/store'
import { ToastPlugin } from '@/store/module/Toast/Toast'
import i18n from './i18n'
import { UserStore } from '@/store/user'
import { download } from '@tauri-apps/plugin-upload'
import { downloadDir, publicDir } from '@tauri-apps/api/path'
import { setStatusBarColor } from 'tauri-plugin-blinko-api'
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getBlinkoFileUrl } from './blinkoEndpoint';

export interface PermissionStatus {
    audio: boolean;
    camera: boolean;
}

/**
 * isAndroid
 * @returns wether the platform is android
 */
export function isAndroid() {
    try {
        return platform() === 'android';
    } catch (error) {
        return false
    }
}

export function isDesktop() {
    try {
       return platform() === 'macos' || platform() === 'windows' || platform() === 'linux';
    } catch (error) {
        return false
    }
}

export function isWindows() {
    try {
        return platform() === 'windows';
    } catch (error) {
        return false
    }
}

export function isInTauri() {
    try {
        // @ts-ignore
        return typeof window !== 'undefined' && window.__TAURI__ !== undefined;
    } catch (error) {
        return false
    }
}

/**
 * downloadFromLink
 * @param uri download link
 * @param filename optional file name, if not provided, it will be extracted from the link
 * https://v2.tauri.app/plugin/file-system/#ios 
 */
export async function downloadFromLink(uri: string, filename?: string) {
    if (!isInTauri()) {
        helper.download.downloadByLink(uri)
        return;
    }

    try {
        RootStore.Get(ToastPlugin).loading(i18n.t('downloading'), { id: 'downloading' })

        const token = RootStore.Get(UserStore).tokenData.value?.token;
        const downloadUrl = getBlinkoFileUrl(uri, { token, download: true });

        if (!filename) {
            const url = new URL(downloadUrl);
            filename = url.pathname.split('/').pop() || 'downloaded_file';
        }

        if (isAndroid()) {
            const downloadDirPath = await downloadDir();
            await download(
                downloadUrl,
                `${downloadDirPath}/${filename}`,
                ({ progress, total }) => {
                    console.log(`download progress: ${progress} / ${total} bytes`);
                },
                new Map([['Content-Type', 'application/octet-stream']])
            );

            RootStore.Get(ToastPlugin).dismiss('downloading');
            RootStore.Get(ToastPlugin).success(i18n.t('download-success') + ' ' + downloadDirPath);
        } else if (platform() !== 'ios') {
            const savePath = await save({
                filters: [
                    {
                        name: 'All Files',
                        extensions: ['*']
                    }
                ],
                defaultPath: filename
            });

            if (savePath) {
                await download(
                    downloadUrl,
                    savePath,
                    ({ progress, total }) => {
                        // console.log(`download progress: ${progress} / ${total} bytes`);
                    },
                    new Map([['Content-Type', 'application/octet-stream']])
                );

                RootStore.Get(ToastPlugin).dismiss('downloading');
                RootStore.Get(ToastPlugin).success(i18n.t('download-success'));
            }
        }

        //todo: IOS download
    } catch (error) {
        RootStore.Get(ToastPlugin).dismiss('downloading');
        RootStore.Get(ToastPlugin).error(`${i18n.t('download-failed')}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function setTauriTheme(theme: any) {
    if (isAndroid()) {
        const lightColor = '#f8f8f8';
        const darkColor = '#000000';
        setStatusBarColor(theme === 'light' ? lightColor : darkColor);
    } else if (isDesktop()) {
        try {
            await invoke('set_desktop_theme', { theme });
        } catch (error) {
            console.error('Failed to set desktop theme:', error);
        }
    }
}




export const requestMicrophonePermission = async (): Promise<boolean> => {
    try {
        // Check cached permission first
        const cachedPermission = localStorage.getItem('microphone_permission_granted');
        if (cachedPermission === 'true') {
            console.log('Using cached microphone permission');
            return true;
        }

        // Check current platform
        const currentPlatform = isInTauri() ? platform() : 'web';
        
        // Try to request permission first
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            }
        }).catch((error) => {
            console.error('getUserMedia error:', error);
            return null;
        });
        
        if (stream) {
            // Permission granted, stop the stream immediately
            stream.getTracks().forEach(track => track.stop());
            // Cache the granted permission
            localStorage.setItem('microphone_permission_granted', 'true');
            return true;
        }
        
        // Handle platform-specific permission denied scenarios
        if (isAndroid()) {
            const shouldShowSettings = confirm(
                'Microphone permission is required for audio recording.\n\n' +
                'Please grant microphone permission in the app settings.\n\n' +
                'Would you like to open settings now?'
            );
            
            if (shouldShowSettings) {
                try {
                    const { openAppSettings } = await import('tauri-plugin-blinko-api');
                    await openAppSettings();
                } catch (error) {
                    console.error('Failed to open app settings:', error);
                    // Fallback: Show instructions
                    alert('Please go to Settings > Apps > Blinko > Permissions and enable Microphone access.');
                }
            }
        } else if (currentPlatform === 'macos') {
            // macOS specific handling
            alert(
                'Microphone permission is required.\n\n' +
                'Please grant microphone access to this app in:\n' +
                'System Preferences > Security & Privacy > Privacy > Microphone'
            );
        } else if (currentPlatform === 'windows') {
            // Windows specific handling
            alert(
                'Microphone permission is required.\n\n' +
                'Please grant microphone access to this app in:\n' +
                'Settings > Privacy & Security > Microphone'
            );
        } else if (currentPlatform === 'linux') {
            // Linux specific handling
            alert(
                'Microphone permission is required.\n\n' +
                'Please ensure your microphone is properly configured and permissions are granted.'
            );
        }
        
        // Clear cache when permission denied
        localStorage.removeItem('microphone_permission_granted');
        return false;
    } catch (error) {
        console.error('Failed to request microphone permission:', error);
        localStorage.removeItem('microphone_permission_granted');
        return false;
    }
};

export const checkMicrophonePermission = async (): Promise<boolean> => {
    try {
        // Check cached permission first
        const cachedPermission = localStorage.getItem('microphone_permission_granted');
        if (cachedPermission === 'true') {
            console.log('Using cached microphone permission');
            return true;
        }

        // Check if the permission API is available (mainly for web)
        if ('permissions' in navigator) {
            try {
                const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
                if (permission.state === 'granted') {
                    localStorage.setItem('microphone_permission_granted', 'true');
                    return true;
                } else if (permission.state === 'denied') {
                    localStorage.removeItem('microphone_permission_granted');
                    return false;
                }
                // If prompt, fall through to test actual access
            } catch (e) {
                // Permission API might not support microphone query
                console.log('Permission API not supported for microphone:', e);
            }
        }

        // Fallback: Try to access the microphone
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            .catch(() => null);

        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            localStorage.setItem('microphone_permission_granted', 'true');
            return true;
        }

        localStorage.removeItem('microphone_permission_granted');
        return false;
    } catch (error) {
        console.error('Error checking microphone permission:', error);
        localStorage.removeItem('microphone_permission_granted');
        return false;
    }
};

export const usePermissions = () => {
    const [permissions, setPermissions] = useState<PermissionStatus>({
        audio: false,
        camera: false,
    });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const checkPermissions = async () => {
            setLoading(true);
            
            try {
                const audioPermission = await checkMicrophonePermission();
                
                setPermissions({
                    audio: audioPermission,
                    camera: false, // Camera permission check can be added later
                });
            } catch (error) {
                console.error('Error checking permissions:', error);
            } finally {
                setLoading(false);
            }
        };

        checkPermissions();
    }, []);

    const requestAudioPermission = async () => {
        const granted = await requestMicrophonePermission();
        setPermissions(prev => ({ ...prev, audio: granted }));
        return granted;
    };

    return {
        permissions,
        loading,
        requestAudioPermission,
    };
};
