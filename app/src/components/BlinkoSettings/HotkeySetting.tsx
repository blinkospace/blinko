import { observer } from 'mobx-react-lite';
import { Button, Input, Switch, Code, Card, CardBody, CardHeader, Divider, Kbd, Select, SelectItem, Checkbox } from '@heroui/react';
import { RootStore } from '@/store';
import { BlinkoStore } from '@/store/blinkoStore';
import { PromiseCall } from '@/store/standard/PromiseState';
import { Icon } from '@/components/Common/Iconify/icons';
import { api } from '@/lib/trpc';
import { useTranslation } from 'react-i18next';
import { Item, ItemWithTooltip } from './Item';
import { useEffect, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { enable, isEnabled, disable } from '@tauri-apps/plugin-autostart';
import { isDesktop, isInTauri, isWindows } from '@/lib/tauriHelper';
import { CollapsibleCard } from '../Common/CollapsibleCard';
import { ToastPlugin } from '@/store/module/Toast/Toast';
import { HotkeyConfig, DEFAULT_HOTKEY_CONFIG, TextSelectionToolbarConfig, DEFAULT_TEXT_SELECTION_TOOLBAR_CONFIG } from '@/../../shared/lib/types';

const HOTKEY_EXAMPLES = {
  'Shift+Space': 'Shift+Space (Recommended)',
  'CommandOrControl+Shift+N': 'Ctrl+Shift+N (Windows/Linux) / ⌘+Shift+N (Mac)',
  'CommandOrControl+Alt+Space': 'Ctrl+Alt+Space (Windows/Linux) / ⌘+Option+Space (Mac)',
  'Alt+Shift+B': 'Alt+Shift+B',
  'F1': 'F1',
  'CommandOrControl+`': 'Ctrl+` (Windows/Linux) / ⌘+` (Mac)',
};

const MODIFIER_KEYS = {
  'CommandOrControl': { windows: 'Ctrl', mac: '⌘', description: 'Main modifier key' },
  'Alt': { windows: 'Alt', mac: 'Option', description: 'Alt key' },
  'Shift': { windows: 'Shift', mac: 'Shift', description: 'Shift key' },
  'Super': { windows: 'Win', mac: '⌘', description: 'System key' },
};

export const HotkeySetting = observer(() => {
  const blinko = RootStore.Get(BlinkoStore);
  const { t } = useTranslation();
  const toast = RootStore.Get(ToastPlugin);

  const [hotkeyConfig, setHotkeyConfig] = useState<HotkeyConfig>(DEFAULT_HOTKEY_CONFIG);
  const [isRecording, setIsRecording] = useState(false);
  const [isRecordingAI, setIsRecordingAI] = useState(false);
  const [recordedKeys, setRecordedKeys] = useState<string[]>([]);
  const [recordedAIKeys, setRecordedAIKeys] = useState<string[]>([]);
  const [registeredShortcuts, setRegisteredShortcuts] = useState<Record<string, string>>({});
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const recordingRef = useRef<HTMLInputElement>(null);
  const recordingAIRef = useRef<HTMLInputElement>(null);


  // Check if running on Tauri desktop
  const isTauriDesktop = isInTauri() && isDesktop();

  // Get current configuration
  const getCurrentConfig = async () => {
    try {
      const config = await blinko.config.value?.desktopHotkeys;
      const finalConfig = {
        ...DEFAULT_HOTKEY_CONFIG,
        ...config,
        systemTrayEnabled: true,
        windowBehavior: 'show' as const
      };
      setHotkeyConfig(finalConfig);

      // Refresh registration status (only if Tauri desktop)
      if (isTauriDesktop) {
        await getRegisteredShortcuts();

        // Initialize text selection monitoring if enabled
        if (finalConfig.textSelectionToolbar?.enabled) {
          try {
            console.log('🎯 Initializing text selection monitoring with config:', finalConfig.textSelectionToolbar);
            console.log('📤 Calling setup_text_selection_monitoring with:', {
              enabled: finalConfig.textSelectionToolbar.enabled,
              triggerModifier: finalConfig.textSelectionToolbar.triggerModifier
            });
            await invoke('setup_text_selection_monitoring', {
              enabled: finalConfig.textSelectionToolbar.enabled,
              triggerModifier: finalConfig.textSelectionToolbar.triggerModifier
            });
            console.log('✅ Text selection monitoring initialized successfully');
          } catch (error) {
            console.error('❌ Failed to initialize text selection monitoring:', error);
          }
        } else {
          console.log('🚫 Text selection monitoring disabled in config');
        }
      }
    } catch (error) {
      console.error('Failed to get hotkey config:', error);
    }
  };

  // Get registered shortcuts
  const getRegisteredShortcuts = async () => {
    if (!isTauriDesktop) return;
    try {
      const shortcuts = await invoke<Record<string, string>>('get_registered_shortcuts');
      setRegisteredShortcuts(shortcuts);
    } catch (error) {
      console.error('Failed to get registered shortcuts:', error);
    }
  };

  // Get autostart status
  const getAutoStartStatus = async () => {
    if (!isTauriDesktop) return;
    try {
      const enabled = await isEnabled();
      setAutoStartEnabled(enabled);
    } catch (error) {
      console.error('Failed to get autostart status:', error);
    }
  };

  // Save configuration
  const saveConfig = async (newConfig: Partial<HotkeyConfig>) => {
    // Ensure system tray is always enabled, window behavior fixed to show
    const updatedConfig = {
      ...hotkeyConfig,
      ...newConfig,
      systemTrayEnabled: true,
      windowBehavior: 'show' as const
    };

    try {
      await PromiseCall(
        api.config.update.mutate({
          key: 'desktopHotkeys',
          value: updatedConfig,
        }),
        { autoAlert: false }
      );

      setHotkeyConfig(updatedConfig);
      toast.success(t('operation-success'));

      // If Tauri desktop, update hotkey registration based on enabled state
      if (isTauriDesktop) {
        if (updatedConfig.enabled) {
          await updateHotkeyRegistration(updatedConfig.quickNote, true);
        } else {
          // Unregister quicknote hotkey when disabled
          try {
            await invoke('unregister_hotkey', { shortcut: hotkeyConfig.quickNote });
            console.log('QuickNote hotkey unregistered due to disable');
          } catch (error) {
            console.warn('Failed to unregister quicknote hotkey on disable:', error);
          }
        }

        if (updatedConfig.aiEnabled) {
          await updateAIHotkeyRegistration(updatedConfig.quickAI, true);
        } else {
          // Unregister quickai hotkey when disabled
          try {
            await invoke('unregister_hotkey', { shortcut: hotkeyConfig.quickAI });
            console.log('QuickAI hotkey unregistered due to disable');
          } catch (error) {
            console.warn('Failed to unregister quickai hotkey on disable:', error);
          }
        }

        // Setup text selection monitoring if configuration changed
        if (updatedConfig.textSelectionToolbar && isTauriDesktop) {
          try {
            await invoke('setup_text_selection_monitoring', {
              enabled: updatedConfig.textSelectionToolbar.enabled,
              triggerModifier: updatedConfig.textSelectionToolbar.triggerModifier
            });
            console.log('Text selection monitoring updated:', updatedConfig.textSelectionToolbar);
          } catch (error) {
            console.warn('Failed to setup text selection monitoring:', error);
          }
        }
      }
    } catch (error) {
      console.error('Failed to save hotkey config:', error);
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  // Update hotkey registration
  const updateHotkeyRegistration = async (newShortcut: string, enabled: boolean = true) => {
    if (!isTauriDesktop) return;

    try {
      // Unregister old shortcut - use current config shortcut, not registration record
      const oldShortcut = hotkeyConfig.quickNote;
      if (oldShortcut && oldShortcut !== newShortcut) {
        try {
          await invoke('unregister_hotkey', { shortcut: oldShortcut });
        } catch (error) {
          console.warn('Failed to unregister old shortcut:', error);
          // Continue execution, old shortcut may not exist
        }
      }

      // Register new shortcut only if enabled
      if (enabled) {
        await invoke('register_hotkey', {
          shortcut: newShortcut,
          command: 'quicknote'
        });
      }

      // Refresh registration status
      await getRegisteredShortcuts();
      console.log('Hotkey registration updated successfully');
    } catch (error) {
      console.error('Failed to update hotkey registration:', error);
      toast.error((error instanceof Error ? error.message : String(error)));
    }
  };

  // Update AI hotkey registration
  const updateAIHotkeyRegistration = async (newShortcut: string, enabled: boolean = true) => {
    if (!isTauriDesktop) return;

    try {
      // Unregister old AI shortcut
      const oldShortcut = hotkeyConfig.quickAI;
      if (oldShortcut && oldShortcut !== newShortcut) {
        try {
          await invoke('unregister_hotkey', { shortcut: oldShortcut });
        } catch (error) {
          console.warn('Failed to unregister old AI shortcut:', error);
          // Continue execution, old shortcut may not exist
        }
      }

      // Register new AI shortcut only if enabled
      if (enabled) {
        await invoke('register_hotkey', {
          shortcut: newShortcut,
          command: 'quickai'
        });
      }

      // Refresh registration status
      await getRegisteredShortcuts();
      console.log('AI Hotkey registration updated successfully');
    } catch (error) {
      console.error('Failed to update AI hotkey registration:', error);
      toast.error((error instanceof Error ? error.message : String(error)));
    }
  };


  // Keyboard event handling for quicknote
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!isRecording) return;

    event.preventDefault();
    event.stopPropagation();

    const keys: string[] = [];

    // Add modifier keys
    if (event.metaKey || event.ctrlKey) keys.push('CommandOrControl');
    if (event.altKey) keys.push('Alt');
    if (event.shiftKey) keys.push('Shift');

    // Add main key
    const mainKey = event.key;
    if (mainKey && !['Control', 'Alt', 'Shift', 'Meta', 'Command'].includes(mainKey)) {
      // Special key mapping
      const keyMap: Record<string, string> = {
        ' ': 'Space',
        'ArrowUp': 'Up',
        'ArrowDown': 'Down',
        'ArrowLeft': 'Left',
        'ArrowRight': 'Right',
        'Escape': 'Esc',
      };

      keys.push(keyMap[mainKey] || mainKey.toUpperCase());
    }

    setRecordedKeys(keys);
  };

  // Keyboard event handling for AI
  const handleAIKeyDown = (event: React.KeyboardEvent) => {
    if (!isRecordingAI) return;

    event.preventDefault();
    event.stopPropagation();

    const keys: string[] = [];

    // Add modifier keys
    if (event.metaKey || event.ctrlKey) keys.push('CommandOrControl');
    if (event.altKey) keys.push('Alt');
    if (event.shiftKey) keys.push('Shift');

    // Add main key
    const mainKey = event.key;
    if (mainKey && !['Control', 'Alt', 'Shift', 'Meta', 'Command'].includes(mainKey)) {
      // Special key mapping
      const keyMap: Record<string, string> = {
        ' ': 'Space',
        'ArrowUp': 'Up',
        'ArrowDown': 'Down',
        'ArrowLeft': 'Left',
        'ArrowRight': 'Right',
        'Escape': 'Esc',
      };

      keys.push(keyMap[mainKey] || mainKey.toUpperCase());
    }

    setRecordedAIKeys(keys);
  };

  // Start/stop shortcut recording
  const toggleRecording = async () => {
    if (isRecording) {
      // Stop recording, apply recorded shortcut
      if (recordedKeys.length > 1) {
        const newShortcut = recordedKeys.join('+');
        // Immediately save to database and update registration
        await saveConfig({ quickNote: newShortcut });
      }
      setIsRecording(false);
      setRecordedKeys([]);
    } else {
      // Start recording
      setIsRecording(true);
      setRecordedKeys([]);
      recordingRef.current?.focus();
    }
  };

  // Start/stop AI shortcut recording
  const toggleAIRecording = async () => {
    if (isRecordingAI) {
      // Stop recording, apply recorded shortcut
      if (recordedAIKeys.length > 1) {
        const newShortcut = recordedAIKeys.join('+');
        // Immediately save to database and update registration
        await saveConfig({ quickAI: newShortcut });
      }
      setIsRecordingAI(false);
      setRecordedAIKeys([]);
    } else {
      // Start recording
      setIsRecordingAI(true);
      setRecordedAIKeys([]);
      recordingAIRef.current?.focus();
    }
  };



  // Format shortcut display
  const formatShortcut = (shortcut: string) => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    return shortcut
      .replace('CommandOrControl', isMac ? '⌘' : 'Ctrl')
      .replace('Alt', isMac ? 'Option' : 'Alt')
      .replace('Shift', '⇧')
      .replace('+', isMac ? '' : '+');
  };

  // Toggle autostart
  const toggleAutoStart = async (enabled: boolean) => {
    if (!isTauriDesktop) return;

    try {
      if (enabled) {
        await enable();
      } else {
        await disable();
      }
      setAutoStartEnabled(enabled);
    } catch (error) {
      console.error('Failed to toggle autostart:', error);
      toast.error((error instanceof Error ? error.message : String(error)));
      // Revert the state on error
      await getAutoStartStatus();
    }
  };

  // Reset to default shortcut
  const resetQuickNoteToDefault = async () => {
    await saveConfig({ quickNote: DEFAULT_HOTKEY_CONFIG.quickNote });
  };

  // Reset AI shortcut to default
  const resetQuickAIToDefault = async () => {
    await saveConfig({ quickAI: DEFAULT_HOTKEY_CONFIG.quickAI });
  };

  // Check if shortcut is not default
  const isQuickNoteNotDefault = hotkeyConfig.quickNote !== DEFAULT_HOTKEY_CONFIG.quickNote;
  const isQuickAINotDefault = hotkeyConfig.quickAI !== DEFAULT_HOTKEY_CONFIG.quickAI;



  // Initialize
  useEffect(() => {
    getCurrentConfig();
    getRegisteredShortcuts();
    getAutoStartStatus();
  }, []);

  // Don't show this setting if not Tauri desktop
  if (!isTauriDesktop) {
    return null;
  }

  return (
    <div>
      <CollapsibleCard
        icon="material-symbols:desktop-windows"
        title="Desktop & Hotkeys"
        className="w-full"
      >
        <div className="flex flex-col gap-4">
          {/* Autostart switch */}
          <Item
            leftContent={
              <ItemWithTooltip
                content="Autostart"
                toolTipContent="Start Blinko automatically on system boot"
              />
            }
            rightContent={
              <Switch
                isSelected={autoStartEnabled}
                onValueChange={toggleAutoStart}
              />
            }
          />

          {/* Hotkey enable switch */}
          <Item
            leftContent={
              <ItemWithTooltip
                content={t('hotkey.enableGlobalHotkey')}
                toolTipContent={t('enable-hotkeys-desc')}
              />
            }
            rightContent={
              <Switch
                isSelected={hotkeyConfig.enabled}
                onValueChange={(enabled) => saveConfig({ enabled })}
              />
            }
          />

          {/* Hotkey configuration */}
          <Item
            leftContent={t('hotkey.quickNoteShortcut')}
            rightContent={
              <div className="flex items-center gap-2">
                <Input
                  ref={recordingRef}
                  value={isRecording ? recordedKeys.join('+') || t('hotkey.pressShortcut') : hotkeyConfig.quickNote}
                  placeholder={t('hotkey.clickRecordButton')}
                  readOnly
                  onKeyDown={handleKeyDown}
                  classNames={{
                    input: "text-center font-mono",
                    inputWrapper: isRecording ? "ring-2 ring-primary" : ""
                  }}
                />
                <Button
                  size="sm"
                  color={isRecording ? "danger" : "primary"}
                  variant={isRecording ? "flat" : "solid"}
                  onPress={toggleRecording}
                  startContent={
                    <Icon icon={isRecording ? "material-symbols:stop" : "material-symbols:keyboard"} />
                  }
                >
                  {isRecording ? t('hotkey.stop') : t('hotkey.record')}
                </Button>
                {isQuickNoteNotDefault && (
                  <Button
                    size="sm"
                    color="default"
                    variant="flat"
                    isIconOnly
                    onPress={resetQuickNoteToDefault}
                    className="opacity-70 hover:opacity-100"
                  >
                    <Icon icon="material-symbols:refresh" />
                  </Button>
                )}
              </div>
            }
            type="col"
          />

        </div>
      </CollapsibleCard>

      {/* Quick AI CollapsibleCard */}
      <CollapsibleCard
        icon="mingcute:ai-line"
        title="Quick AI"
        className="w-full mt-6"
      >
        <div className="flex flex-col gap-4">
          {/* AI hotkey enable switch */}
          <Item
            leftContent={
              <ItemWithTooltip
                content="Enable Quick AI"
                toolTipContent="Enable hotkey to quickly open AI input dialog"
              />
            }
            rightContent={
              <Switch
                isSelected={hotkeyConfig.aiEnabled}
                onValueChange={(enabled) => saveConfig({ aiEnabled: enabled })}
              />
            }
          />

          {/* AI Hotkey configuration */}
          <Item
            leftContent="Quick AI Shortcut"
            rightContent={
              <div className="flex items-center gap-2">
                <Input
                  ref={recordingAIRef}
                  value={isRecordingAI ? recordedAIKeys.join('+') || t('hotkey.pressShortcut') : hotkeyConfig.quickAI}
                  placeholder={t('hotkey.clickRecordButton')}
                  readOnly
                  onKeyDown={handleAIKeyDown}
                  classNames={{
                    input: "text-center font-mono",
                    inputWrapper: isRecordingAI ? "ring-2 ring-primary" : ""
                  }}
                />
                <Button
                  size="sm"
                  color={isRecordingAI ? "danger" : "primary"}
                  variant={isRecordingAI ? "flat" : "solid"}
                  onPress={toggleAIRecording}
                  startContent={
                    <Icon icon={isRecordingAI ? "material-symbols:stop" : "material-symbols:keyboard"} />
                  }
                >
                  {isRecordingAI ? t('hotkey.stop') : t('hotkey.record')}
                </Button>
                {isQuickAINotDefault && (
                  <Button
                    size="sm"
                    color="default"
                    variant="flat"
                    isIconOnly
                    onPress={resetQuickAIToDefault}
                    className="opacity-70 hover:opacity-100"
                  >
                    <Icon icon="material-symbols:refresh" />
                  </Button>
                )}
              </div>
            }
            type="col"
          />

        </div>
      </CollapsibleCard>

      {/* Text Selection Toolbar CollapsibleCard */}
      <CollapsibleCard
        icon="material-symbols:select-all"
        title={t('text-selection-toolbar')}
        className="w-full my-6"
      >
        <div className="flex flex-col gap-4">
          {/* Text selection toolbar enable switch */}
          <Item
            leftContent={
              <ItemWithTooltip
                content="Enable Text Selection Toolbar"
                toolTipContent="Show toolbar when text is selected globally on desktop"
              />
            }
            rightContent={
              <Switch
                isSelected={hotkeyConfig.textSelectionToolbar?.enabled ?? DEFAULT_TEXT_SELECTION_TOOLBAR_CONFIG.enabled}
                onValueChange={(enabled) =>
                  saveConfig({
                    textSelectionToolbar: {
                      ...hotkeyConfig.textSelectionToolbar,
                      ...DEFAULT_TEXT_SELECTION_TOOLBAR_CONFIG,
                      enabled
                    }
                  })
                }
              />
            }
          />

          {/* Trigger modifier selection */}
          <Item
            leftContent={t('trigger-modifier')}
            rightContent={
              <Select
                size="sm"
                selectedKeys={[hotkeyConfig.textSelectionToolbar?.triggerModifier ?? DEFAULT_TEXT_SELECTION_TOOLBAR_CONFIG.triggerModifier]}
                onSelectionChange={(keys) => {
                  const modifier = Array.from(keys)[0] as 'ctrl' | 'shift' | 'alt';
                  saveConfig({
                    textSelectionToolbar: {
                      ...hotkeyConfig.textSelectionToolbar,
                      ...DEFAULT_TEXT_SELECTION_TOOLBAR_CONFIG,
                      triggerModifier: modifier
                    }
                  });
                }}
                className="w-32"
              >
                <SelectItem key="ctrl" >Ctrl + `</SelectItem>
                <SelectItem key="shift">Shift + `</SelectItem>
                <SelectItem key="alt">Alt + `</SelectItem>
              </Select>
            }
            type="col"
          />

          {/* Translation language settings */}
          <Item
            leftContent={t('translation-languages')}
            rightContent={
              <div className="flex gap-2">
                <Select
                  size="sm"
                  selectedKeys={[hotkeyConfig.textSelectionToolbar?.translationFromLang ?? DEFAULT_TEXT_SELECTION_TOOLBAR_CONFIG.translationFromLang]}
                  onSelectionChange={(keys) => {
                    const fromLang = Array.from(keys)[0] as string;
                    saveConfig({
                      textSelectionToolbar: {
                        ...hotkeyConfig.textSelectionToolbar,
                        ...DEFAULT_TEXT_SELECTION_TOOLBAR_CONFIG,
                        translationFromLang: fromLang
                      }
                    });
                  }}
                  className="w-24"
                >
                  <SelectItem key="auto">Auto</SelectItem>
                  <SelectItem key="en">English</SelectItem>
                  <SelectItem key="zh">Chinese</SelectItem>
                  <SelectItem key="ja">Japanese</SelectItem>
                  <SelectItem key="ko">Korean</SelectItem>
                  <SelectItem key="fr">French</SelectItem>
                  <SelectItem key="de">German</SelectItem>
                  <SelectItem key="es">Spanish</SelectItem>
                </Select>
                <span className="text-sm text-gray-500 self-center">→</span>
                <Select
                  size="sm"
                  selectedKeys={[hotkeyConfig.textSelectionToolbar?.translationToLang ?? DEFAULT_TEXT_SELECTION_TOOLBAR_CONFIG.translationToLang]}
                  onSelectionChange={(keys) => {
                    const toLang = Array.from(keys)[0] as string;
                    saveConfig({
                      textSelectionToolbar: {
                        ...hotkeyConfig.textSelectionToolbar,
                        ...DEFAULT_TEXT_SELECTION_TOOLBAR_CONFIG,
                        translationToLang: toLang
                      }
                    });
                  }}
                  className="w-24"
                >
                  <SelectItem key="en">English</SelectItem>
                  <SelectItem key="zh">Chinese</SelectItem>
                  <SelectItem key="ja">Japanese</SelectItem>
                  <SelectItem key="ko">Korean</SelectItem>
                  <SelectItem key="fr">French</SelectItem>
                  <SelectItem key="de">German</SelectItem>
                  <SelectItem key="es">Spanish</SelectItem>
                </Select>
              </div>
            }
            type="col"
          />

        </div>
      </CollapsibleCard>
    </div>
  );
});