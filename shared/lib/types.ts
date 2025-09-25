import { RouterOutput } from "../../server/routerTrpc/_app";
import { z } from "zod";

export type Note = Partial<NonNullable<RouterOutput['notes']['list'][0]>>
export type Attachment = NonNullable<Note['attachments']>[0] & { size: any }
export type Tag = NonNullable<RouterOutput['tags']['list']>[0]
export type Config = NonNullable<RouterOutput['config']['list']>
export type LinkInfo = NonNullable<RouterOutput['public']['linkPreview']>
export type ResourceType = NonNullable<RouterOutput['attachments']['list']>[0]
export type Comment = NonNullable<RouterOutput['comments']['list']>
export type InstalledPluginInfo = NonNullable<RouterOutput['plugin']['getInstalledPlugins']>[0]
export type Conversation = NonNullable<RouterOutput['conversation']['list']>[0]
export type Message = NonNullable<RouterOutput['message']['list']>[0]
export enum NoteType {
  'BLINKO',
  'NOTE',
  'TODO'
}
export type PublicUser = NonNullable<RouterOutput['users']['publicUserList']>[0]
export function toNoteTypeEnum(v?: number, fallback: NoteType = NoteType.BLINKO): NoteType {
  switch (v) {
    case 0:
      return NoteType.BLINKO;
    case 1:
      return NoteType.NOTE;
    case 2:
      return NoteType.TODO;
    default:
      return fallback;
  }
}

export const ZUserPerferConfigKey = z.union([
  z.literal('textFoldLength'),
  z.literal('smallDeviceCardColumns'),
  z.literal('mediumDeviceCardColumns'),
  z.literal('largeDeviceCardColumns'),
  z.literal('timeFormat'),
  z.literal('isHiddenMobileBar'),
  z.literal('isHideCommentInCard'),
  z.literal('isOrderByCreateTime'),
  z.literal('language'),
  z.literal('theme'),
  z.literal('webhookEndpoint'),
  z.literal('toolbarVisibility'),
  z.literal('twoFactorEnabled'),
  z.literal('twoFactorSecret'),
  z.literal('themeColor'),
  z.literal('themeForegroundColor'),
  z.literal('isCloseDailyReview'),
  z.literal('maxHomePageWidth'),
  z.literal('isUseBlinkoHub'),
  z.literal('isHiddenNotification'),
  z.literal('hidePcEditor'),
  z.literal('defaultHomePage'),
  z.literal('desktopHotkeys'),
  z.literal('systemTray'),
]);

export const ZConfigKey = z.union([
  z.literal('isAutoArchived'),
  z.literal('autoArchivedDays'),
  z.literal('mainModelId'),
  z.literal('embeddingModelId'),
  z.literal('voiceModelId'),
  z.literal('rerankModelId'),
  z.literal('imageModelId'),
  z.literal('audioModelId'),
  z.literal('realTimeVoiceModelId'),
  z.literal('embeddingDimensions'),
  z.literal('embeddingTopK'),
  z.literal('embeddingScore'),
  z.literal('excludeEmbeddingTagId'),
  z.literal('rerankTopK'),
  z.literal('rerankScore'),
  z.literal('isAllowRegister'),
  z.literal('objectStorage'),
  z.literal('s3AccessKeyId'),
  z.literal('s3AccessKeySecret'),
  z.literal('s3Endpoint'),
  z.literal('s3Bucket'),
  z.literal('s3Region'),
  z.literal('s3CustomPath'),
  z.literal('localCustomPath'),
  z.literal('spotifyConsumerKey'),
  z.literal('spotifyConsumerSecret'),
  z.literal('isCloseBackgroundAnimation'),
  z.literal('customBackgroundUrl'),
  z.literal('oauth2Providers'),
  z.literal('tavilyApiKey'),
  z.literal('tavilyMaxResult'),
  z.literal('isUseAiPostProcessing'),
  z.literal('aiCommentPrompt'),
  z.literal('aiTagsPrompt'),
  z.literal('aiPostProcessingMode'),
  z.literal('aiCustomPrompt'),
  z.literal('isUseHttpProxy'),
  z.literal('httpProxyHost'),
  z.literal('httpProxyPort'),
  z.literal('httpProxyUsername'),
  z.literal('httpProxyPassword'),
  z.literal('aiSmartEditPrompt'),
  z.literal('globalPrompt'),
  ZUserPerferConfigKey,
  z.any()
]);

export type ConfigKey = z.infer<typeof ZConfigKey>;

export const ZOAuth2ProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().optional(),
  wellKnown: z.string().optional(),
  scope: z.string().optional(),
  authorizationUrl: z.string().optional(),
  tokenUrl: z.string(),
  userinfoUrl: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
});

export const ZConfigSchema = z.object({
  isAutoArchived: z.boolean().optional(),
  autoArchivedDays: z.number().nullable().optional(),
  mainModelId: z.number().nullable().optional(),
  embeddingModelId: z.number().nullable().optional(),
  voiceModelId: z.number().nullable().optional(),
  rerankModelId: z.number().nullable().optional(),
  imageModelId: z.number().nullable().optional(),
  audioModelId: z.number().nullable().optional(),
  realTimeVoiceModelId: z.number().nullable().optional(),
  isHiddenMobileBar: z.boolean().optional(),
  isHideCommentInCard: z.boolean().optional(),
  toolbarVisibility: z.any().optional(),
  isAllowRegister: z.any().optional(),
  isCloseBackgroundAnimation: z.boolean().optional(),
  customBackgroundUrl: z.any().optional(),
  isOrderByCreateTime: z.any().optional(),
  timeFormat: z.any().optional(),
  smallDeviceCardColumns: z.any().optional(),
  mediumDeviceCardColumns: z.any().optional(),
  largeDeviceCardColumns: z.any().optional(),
  textFoldLength: z.number().nullable().optional(),
  objectStorage: z.any().optional(),
  s3AccessKeyId: z.any().optional(),
  s3AccessKeySecret: z.any().optional(),
  s3Endpoint: z.any().optional(),
  s3Bucket: z.any().optional(),
  s3CustomPath: z.any().optional(),
  s3Region: z.any().optional(),
  localCustomPath: z.any().optional(),
  embeddingDimensions: z.number().nullable().optional(),
  embeddingTopK: z.number().nullable().optional(),
  embeddingScore: z.number().nullable().optional(),
  excludeEmbeddingTagId: z.number().nullable().optional(),
  rerankTopK: z.number().nullable().optional(),
  rerankScore: z.number().nullable().optional(),
  language: z.any().optional(),
  theme: z.any().optional(),
  themeColor: z.any().optional(),
  themeForegroundColor: z.any().optional(),
  webhookEndpoint: z.any().optional(),
  twoFactorEnabled: z.boolean().optional(),
  twoFactorSecret: z.string().optional(),
  spotifyConsumerKey: z.string().optional(),
  spotifyConsumerSecret: z.string().optional(),
  isCloseDailyReview: z.boolean().optional(),
  maxHomePageWidth: z.number().nullable().optional(),
  oauth2Providers: z.array(ZOAuth2ProviderSchema).optional(),
  isUseBlinkoHub: z.boolean().optional(),
  isHiddenNotification: z.boolean().optional(),
  tavilyApiKey: z.any().optional(),
  tavilyMaxResult: z.any().optional(),
  isUseAiPostProcessing: z.boolean().optional(),
  aiCommentPrompt: z.string().optional(),
  aiTagsPrompt: z.string().optional(),
  aiPostProcessingMode: z.string().optional(),
  aiCustomPrompt: z.string().optional(),
  aiSmartEditPrompt: z.string().optional(),
  globalPrompt: z.string().optional(),
  isUseHttpProxy: z.boolean().optional(),
  httpProxyHost: z.string().optional(),
  httpProxyPort: z.number().nullable().optional(),
  httpProxyUsername: z.string().optional(),
  httpProxyPassword: z.string().optional(),
  hidePcEditor: z.boolean().optional(),
  defaultHomePage: z.string().optional(),
  desktopHotkeys: z.any().optional(),
  systemTray: z.any().optional(),
});

export type GlobalConfig = z.infer<typeof ZConfigSchema>;

// Zod schema for plugin information
export const pluginInfoSchema = z.object({
  name: z.string(),
  author: z.string().optional(),
  url: z.string().optional(),
  version: z.string(),
  minAppVersion: z.string().optional(),
  displayName: z.any().optional(),
  description: z.any().optional(),
  readme: z.any().optional(),
  downloads: z.number().nullable().optional()
});

// Schema for plugin installation input (subset of PluginInfo)
export const installPluginSchema = pluginInfoSchema.omit({
  readme: true,
  downloads: true
});

// TypeScript types derived from the schemas
export type PluginInfo = z.infer<typeof pluginInfoSchema>;
export type InstallPluginInput = z.infer<typeof installPluginSchema>; 

export type RestoreResult = {
  type: 'success' | 'skip' | 'error';
  content?: string;
  error?: unknown;
  progress?: { current: number; total: number };
}

export type ProgressResult = {
  type: 'success' | 'skip' | 'error' | 'info';
  content?: string;
  error?: unknown;
}

// Desktop Hotkey Configuration Types
export interface HotkeyConfig {
  quickNote: string;           // Quick note hotkey
  quickAI: string;             // Quick AI hotkey
  enabled: boolean;            // Enable hotkeys
  aiEnabled: boolean;          // Enable AI hotkey
  systemTrayEnabled: boolean;  // Enable system tray
  windowBehavior: 'show' | 'hide' | 'minimize'; // Window behavior
  textSelectionToolbar: TextSelectionToolbarConfig; // Text selection toolbar config
}

// Text Selection Toolbar Configuration
export interface TextSelectionToolbarConfig {
  enabled: boolean;            // Enable text selection toolbar
  triggerModifier: 'ctrl' | 'shift' | 'alt'; // Modifier key to trigger toolbar
  translationFromLang: string; // Source language for translation
  translationToLang: string;   // Target language for translation
  features: {
    translation: boolean;      // Enable translation feature
    copy: boolean;            // Enable copy feature
    qna: boolean;             // Enable Q&A feature
    bookmark: boolean;        // Enable bookmark feature
  };
}

export const DEFAULT_TEXT_SELECTION_TOOLBAR_CONFIG: TextSelectionToolbarConfig = {
  enabled: true,
  triggerModifier: 'ctrl',
  translationFromLang: 'auto',
  translationToLang: 'zh',
  features: {
    translation: true,
    copy: true,
    qna: true,
    bookmark: true
  }
};

export const DEFAULT_HOTKEY_CONFIG: HotkeyConfig = {
  quickNote: 'Shift+Space',
  quickAI: 'Alt+Space',
  enabled: true,
  aiEnabled: true,
  systemTrayEnabled: true,
  windowBehavior: 'show',
  textSelectionToolbar: DEFAULT_TEXT_SELECTION_TOOLBAR_CONFIG
};

// System Tray Configuration
export interface SystemTrayConfig {
  enabled: boolean;
  showInTray: boolean;
  minimizeToTray: boolean;
  closeToTray: boolean;
}

export const DEFAULT_SYSTEM_TRAY_CONFIG: SystemTrayConfig = {
  enabled: true,
  showInTray: true,
  minimizeToTray: true,
  closeToTray: false
};

// Platform detection utility type
export interface PlatformInfo {
  isTauri: boolean;
  isDesktop: boolean;
  platform: 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'web';
}

// Hotkey event types for Tauri communication
export interface HotkeyEvent {
  type: 'quicknote-triggered' | 'window-toggle' | 'settings-open';
  payload?: any;
}

// Tray menu item types
export interface TrayMenuItem {
  id: string;
  label: string;
  accelerator?: string;
  enabled?: boolean;
  visible?: boolean;
  type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio';
}