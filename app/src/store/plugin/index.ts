/// <reference types="systemjs" preserve="true" />
import { api } from "../../lib/trpc";
import { eventBus } from "../../lib/event";
import i18n from "@/lib/i18n";
import { ToastPlugin } from "../module/Toast/Toast";
import { BaseStore } from "../baseStore";
import { BlinkoStore } from "../blinkoStore";
import { HubStore } from "../hubStore";
import { ResourceStore } from "../resourceStore";
import { StorageState } from "../standard/StorageState";
import { PromiseState } from "../standard/PromiseState";
import { PromisePageState } from "../standard/PromiseState";
import { PluginApiStore } from "./pluginApiStore";
import copy from "copy-to-clipboard"
import { UserStore } from "../user";

import type { PluginServicesSdk } from "./services";
export * from "./services";

declare global {
  interface Window {
    Blinko: {
      api: typeof api;
      /** 通用插件服务薄 SDK；旧 api 字段保持不变。 */
      services: PluginServicesSdk;
      eventBus: typeof eventBus;
      i18n: typeof i18n;
      version: string;
      copyToClipboard: typeof copy;
      toast: InstanceType<typeof ToastPlugin>;
      store: {
        StorageState: typeof StorageState;
        PromiseState: typeof PromiseState;
        PromisePageState: typeof PromisePageState;
        blinkoStore: InstanceType<typeof BlinkoStore>;
        baseStore: InstanceType<typeof BaseStore>;
        hubStore: InstanceType<typeof HubStore>;
        resourceStore: InstanceType<typeof ResourceStore>;
        userStore: InstanceType<typeof UserStore>;
      };
      globalRefresh: () => void;
    } & InstanceType<typeof PluginApiStore>;
    System?: typeof System;
  }
}

export interface I18nString {
  default: string;
  zh?: string;
  'zh-tw'?: string;
  en?: string;
  vi?: string;
  tr?: string;
  ka?: string;
  de?: string;
  es?: string;
  fr?: string;
  pt?: string;
  pl?: string;
  ru?: string;
  ko?: string;
  ja?: string;
  [key: string]: string | undefined;
}

/**
 * Abstract base class for all plugins in the application.
 * Provides common properties and methods that all plugins should implement.
 */
export abstract class BasePlugin {
  /** Plugin name (unique identifier) */
  name?: string;
  /** Author of the plugin */
  author?: string;
  /** URL for plugin documentation or repository */
  url?: string;
  /** Current version of the plugin */
  version?: string;
  /** Minimum required app version for compatibility */
  minAppVersion?: string;
  /** Display name for the plugin (supports i18n) */
  displayName?: I18nString;
  /** Short description of the plugin (supports i18n) */
  description?: I18nString;
  /** Detailed readme content (supports i18n) */
  readme?: I18nString;
  /** Icon URL or icon identifier for the plugin */
  icon?: string;
  /** Flag indicating if the plugin has a settings panel */
  withSettingPanel?: boolean;
  /** Function to render the settings panel UI */
  renderSettingPanel?: () => HTMLElement;

  /**
   * Constructs a new BasePlugin instance
   * @param args - Partial object containing plugin configuration
   */
  constructor(args: Partial<BasePlugin>) {
    Object.assign(this, args);
  }

  /**
   * Initialization method called when the plugin is loaded
   * Must be implemented by derived classes
   */
  abstract init(): void;

  /**
   * Cleanup method called when the plugin is unloaded
   * Must be implemented by derived classes
   */
  abstract destroy(): void;
}