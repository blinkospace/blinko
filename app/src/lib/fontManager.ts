/**
 * FontManager - A singleton class for managing web fonts dynamically
 * 
 * Features:
 * - Lazy loading fonts - binary data fetched only when needed
 * - Caching loaded fonts to avoid re-downloading
 * - Applying fonts to document body
 * - Integration with the fonts database
 * - Support for CDN URLs as fallback
 */

import { api } from './trpc';

// Font metadata (without binary data)
export interface FontMetadata {
  id: number;
  name: string;
  displayName: string;
  url: string | null;
  isLocal: boolean;
  weights: number[];
  category: string;
  isSystem: boolean;
  sortOrder: number;
}

// Full font config with binary data (used internally after fetching)
export interface FontConfig extends FontMetadata {
  fileData?: string | null; // Base64 string, fetched on demand
}

interface LoadedFont {
  name: string;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  blobUrl?: string; // Store blob URL for cleanup
}

class FontManagerClass {
  private static instance: FontManagerClass;
  private loadedFonts: Map<string, LoadedFont> = new Map();
  private fontRegistry: Map<string, FontConfig> = new Map();
  private currentFont: string = 'default';
  private initialized: boolean = false;
  private observer: MutationObserver | null = null;
  private currentFontFamily: string = '';

  private constructor() {
    // Initialize with default font
    this.loadedFonts.set('default', {
      name: 'default',
      loaded: true,
      loading: false,
      error: null,
    });
    
    // Setup MutationObserver to watch for new markdown-body elements
    this.setupMutationObserver();
  }
  
  /**
   * Setup MutationObserver to automatically apply font to new markdown-body elements
   */
  private setupMutationObserver(): void {
    if (typeof window === 'undefined' || !window.MutationObserver) return;
    
    // Use a debounce mechanism to avoid excessive DOM queries
    let debounceTimer: number | null = null;
    this.observer = new MutationObserver((mutations) => {
      if (!this.currentFontFamily) return;
      
      // Debounce: batch DOM updates
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      
      debounceTimer = window.setTimeout(() => {
        const elementsToUpdate: HTMLElement[] = [];
        
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const element = node as HTMLElement;
              
              // Check if the added node is a markdown-body
              if (element.classList?.contains('markdown-body')) {
                elementsToUpdate.push(element);
              }
              
              // Check for markdown-body descendants
              const markdownBodies = element.querySelectorAll?.('.markdown-body');
              markdownBodies?.forEach((mb) => {
                elementsToUpdate.push(mb as HTMLElement);
              });
            }
          });
        });
        
        // Batch apply font family
        elementsToUpdate.forEach((el) => {
          el.style.fontFamily = this.currentFontFamily;
        });
      }, 50); // 50ms debounce
    });
    
    // Start observing
    if (document.body) {
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    } else {
      // Wait for body to be available (with timeout to prevent infinite loop)
      let attempts = 0;
      const maxAttempts = 50; // 5 seconds max wait
      const checkBody = setInterval(() => {
        attempts++;
        if (document.body) {
          this.observer?.observe(document.body, {
            childList: true,
            subtree: true,
          });
          clearInterval(checkBody);
        } else if (attempts >= maxAttempts) {
          // Give up after max attempts
          clearInterval(checkBody);
          console.warn('FontManager: document.body not available after timeout, MutationObserver not started');
        }
      }, 100);
    }
  }
  
  /**
   * Get singleton instance
   */
  public static getInstance(): FontManagerClass {
    if (!FontManagerClass.instance) {
      FontManagerClass.instance = new FontManagerClass();
    }
    return FontManagerClass.instance;
  }

  /**
   * Initialize the font manager with font metadata from the database
   * Note: This only stores metadata, binary data is fetched on-demand
   */
  public initializeRegistry(fonts: FontMetadata[]): void {
    this.fontRegistry.clear();
    fonts.forEach(font => {
      this.fontRegistry.set(font.name, font);
    });
    this.initialized = true;
  }

  /**
   * Get all registered fonts
   */
  public getRegisteredFonts(): FontConfig[] {
    return Array.from(this.fontRegistry.values());
  }

  /**
   * Get font by name
   */
  public getFont(name: string): FontConfig | undefined {
    return this.fontRegistry.get(name);
  }

  /**
   * Check if a font is loaded
   */
  public isFontLoaded(fontName: string): boolean {
    return this.loadedFonts.get(fontName)?.loaded ?? false;
  }

  /**
   * Check if a font is currently loading
   */
  public isFontLoading(fontName: string): boolean {
    return this.loadedFonts.get(fontName)?.loading ?? false;
  }

  /**
   * Get the current applied font
   */
  public getCurrentFont(): string {
    return this.currentFont;
  }

  /**
   * Load a font by injecting styles (local @font-face or Google Fonts CSS link)
   */
  public async loadFont(fontName: string): Promise<boolean> {
    // Default font is always "loaded"
    if (fontName === 'default') {
      return true;
    }

    // Check if already loaded
    const existingState = this.loadedFonts.get(fontName);
    if (existingState?.loaded) {
      return true;
    }

    // Check if currently loading
    if (existingState?.loading) {
      // Wait for existing load to complete
      return this.waitForFontLoad(fontName);
    }

    // Get font config
    const fontConfig = this.fontRegistry.get(fontName);
    if (!fontConfig) {
      console.warn(`FontManager: Font "${fontName}" not found in registry`);
      // Font not found, return false to indicate load failure
      return false;
    }

    // Mark as loading
    this.loadedFonts.set(fontName, {
      name: fontName,
      loaded: false,
      loading: true,
      error: null,
    });

    try {
      // Check if it's a local font - need to fetch binary data on demand
      if (fontConfig.isLocal) {
        // Fetch binary data from API (lazy loading)
        const fontData = await api.fonts.getFontData.query({ name: fontName });
        
        if (fontData.fileData) {
          await this.loadFontFromBinaryData(fontName, fontData.fileData, fontConfig.weights);
        } else {
          throw new Error(`No font data available for "${fontName}"`);
        }
      } else if (fontConfig.url) {
        // CDN font - inject stylesheet
        await this.injectFontStylesheet(fontConfig.url, fontName);
      }

      // Wait for the font to be actually available
      await this.waitForFontAvailable(fontName);

      // Mark as loaded
      this.loadedFonts.set(fontName, {
        name: fontName,
        loaded: true,
        loading: false,
        error: null,
      });

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.loadedFonts.set(fontName, {
        name: fontName,
        loaded: false,
        loading: false,
        error: errorMessage,
      });
      console.error(`FontManager: Failed to load font "${fontName}":`, error);
      return false;
    }
  }

  /**
   * Load a font from base64-encoded binary data
   * Converts the binary data to a Blob URL and uses FontFace API
   */
  private async loadFontFromBinaryData(
    fontName: string, 
    fileData: string, 
    weights: number[]
  ): Promise<void> {
    // Check if already injected
    const existingStyle = document.querySelector(`style[data-font="${fontName}"]`);
    if (existingStyle) {
      return;
    }

    // Decode base64 to Uint8Array
    const binaryString = atob(fileData);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const binaryData = bytes;

    // Detect font format from magic bytes
    const format = this.detectFontFormat(binaryData);
    
    // Create a Blob from the binary data
    const mimeType = format === 'woff2' ? 'font/woff2' : 
                     format === 'woff' ? 'font/woff' : 
                     format === 'ttf' ? 'font/ttf' : 
                     'font/opentype';
    
    // Create Blob directly from existing Uint8Array
    const blob = new Blob([binaryData], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);

    // Store blob URL for cleanup
    const loadedFontState = this.loadedFonts.get(fontName);
    if (loadedFontState) {
      loadedFontState.blobUrl = blobUrl;
    }

    // Use FontFace API for more reliable font loading
    try {
      // Determine font-weight descriptor based on whether it's a variable font
      const isVariable = weights.length > 4; // Variable fonts typically have many weights
      const weightDescriptor = isVariable ? '100 900' : weights.join(' ');

      const fontFace = new FontFace(fontName, `url(${blobUrl})`, {
        weight: weightDescriptor,
        style: 'normal',
        display: 'swap'
      });

      // Load the font
      await fontFace.load();

      // Add to document fonts
      document.fonts.add(fontFace);

      // Also inject a style tag as fallback for CSS usage
      const fontFaceCSS = `
        @font-face {
          font-family: '${fontName}';
          src: url('${blobUrl}') format('${format}');
          font-weight: ${isVariable ? '100 900' : weights.join(' ')};
          font-style: normal;
          font-display: swap;
        }
      `;

      const style = document.createElement('style');
      style.setAttribute('data-font', fontName);
      style.textContent = fontFaceCSS;
      document.head.appendChild(style);

    } catch (error) {
      // Cleanup blob URL on error
      URL.revokeObjectURL(blobUrl);
      throw error;
    }
  }

  /**
   * Detect font format from magic bytes
   */
  private detectFontFormat(data: Uint8Array): 'woff2' | 'woff' | 'ttf' | 'otf' {
    if (data.length < 4) return 'ttf';

    // WOFF2: starts with 'wOF2' (0x774F4632)
    if (data[0] === 0x77 && data[1] === 0x4F && data[2] === 0x46 && data[3] === 0x32) {
      return 'woff2';
    }

    // WOFF: starts with 'wOFF' (0x774F4646)
    if (data[0] === 0x77 && data[1] === 0x4F && data[2] === 0x46 && data[3] === 0x46) {
      return 'woff';
    }

    // TTF: starts with 0x00010000 or 'true' (0x74727565)
    if ((data[0] === 0x00 && data[1] === 0x01 && data[2] === 0x00 && data[3] === 0x00) ||
        (data[0] === 0x74 && data[1] === 0x72 && data[2] === 0x75 && data[3] === 0x65)) {
      return 'ttf';
    }

    // OTF: starts with 'OTTO' (0x4F54544F)
    if (data[0] === 0x4F && data[1] === 0x54 && data[2] === 0x54 && data[3] === 0x4F) {
      return 'otf';
    }

    // Default to ttf as fallback (more compatible than assuming woff2)
    return 'ttf';
  }



  /**
   * Inject a font stylesheet link tag
   */
  private async injectFontStylesheet(url: string, fontName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check if already injected
      const existingLink = document.querySelector(`link[data-font="${fontName}"]`);
      if (existingLink) {
        resolve();
        return;
      }

      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      link.setAttribute('data-font', fontName);
      
      link.onload = () => resolve();
      link.onerror = () => reject(new Error(`Failed to load stylesheet for font: ${fontName}`));
      
      document.head.appendChild(link);
    });
  }

  /**
   * Wait for a font to become available in the document
   */
  private async waitForFontAvailable(fontName: string, timeout: number = 5000): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      // Use document.fonts API to check if font is loaded
      if (document.fonts) {
        const fontFaces = document.fonts.values();
        for (const fontFace of fontFaces) {
          if (fontFace.family.replace(/['"]/g, '') === fontName && fontFace.status === 'loaded') {
            return;
          }
        }
        
        // Also try checking with document.fonts.check
        try {
          if (document.fonts.check(`16px "${fontName}"`)) {
            return;
          }
        } catch {
          // Ignore check errors
        }
      }
      
      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Font might still work even if we can't confirm it's loaded
    console.warn(`FontManager: Timeout waiting for font "${fontName}" to load; continuing without confirmed load status (font may not be applied correctly)`);
  }

  /**
   * Wait for an existing font load operation to complete
   */
  private async waitForFontLoad(fontName: string, timeout: number = 10000): Promise<boolean> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const state = this.loadedFonts.get(fontName);
      if (state?.loaded) {
        return true;
      }
      if (state?.error) {
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return false;
  }

  /**
   * Apply a font to the document body and CSS variables
   */
  public async applyFont(fontName: string): Promise<boolean> {
    if (fontName === 'default') {
      // Reset to system font stack
      this.currentFontFamily = '';
      document.body.style.fontFamily = '';
      document.documentElement.style.setProperty('--font-family', '');
      
      // Clear font from all elements
      const expandedContainers = document.querySelectorAll('.expanded-container');
      expandedContainers.forEach((container) => {
        (container as HTMLElement).style.fontFamily = '';
      });
      
      const markdownBodies = document.querySelectorAll('.markdown-body');
      markdownBodies.forEach((element) => {
        (element as HTMLElement).style.fontFamily = '';
      });
      
      this.currentFont = 'default';
      return true;
    }
    
    // Get font config to build font family string
    const fontConfig = this.fontRegistry.get(fontName);
    if (!fontConfig) {
      console.warn(`FontManager: Font "${fontName}" not found in registry`);
      return false;
    }
    
    const fallback = this.getFallbackStack(fontConfig.category || 'sans-serif');
    const fontFamily = `"${fontName}", ${fallback}`;
    
    // ⚡ IMMEDIATE: Apply font name right away (browser will use fallback until font loads)
    this.currentFontFamily = fontFamily;
    this.currentFont = fontName;
    
    // Apply to document body immediately
    document.body.style.fontFamily = fontFamily;
    
    // Apply to CSS variable for global use
    document.documentElement.style.setProperty('--font-family', fontFamily);
    
    // Apply to all existing elements immediately
    const expandedContainers = document.querySelectorAll('.expanded-container');
    expandedContainers.forEach((container) => {
      (container as HTMLElement).style.fontFamily = fontFamily;
    });
    
    const markdownBodies = document.querySelectorAll('.markdown-body');
    markdownBodies.forEach((element) => {
      (element as HTMLElement).style.fontFamily = fontFamily;
    });
    
    // 🔄 BACKGROUND: Load font asynchronously (browser will switch when ready)
    // Don't wait for this - let it happen in background
    this.loadFont(fontName).catch((error) => {
      console.warn(`FontManager: Background font load failed for "${fontName}":`, error);
      // Font name is already applied, so fallback will be used
    });
    
    return true;
  }

  /**
   * Get fallback font stack based on category
   */
  private getFallbackStack(category: string): string {
    switch (category) {
      case 'serif':
        return 'Georgia, "Times New Roman", serif';
      case 'monospace':
        return '"Courier New", Consolas, monospace';
      case 'display':
      case 'handwriting':
        return 'cursive';
      case 'sans-serif':
      default:
        return '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
    }
  }

  /**
   * Preload popular fonts in the background
   */

  /**
   * Get loading status for debugging
   */
  public getLoadingStatus(): Record<string, LoadedFont> {
    return Object.fromEntries(this.loadedFonts);
  }

  /**
   * Clear all loaded fonts (except default)
   */
  public clearLoadedFonts(): void {
    // Revoke blob URLs to free memory
    this.loadedFonts.forEach((font) => {
      if (font.blobUrl) {
        URL.revokeObjectURL(font.blobUrl);
      }
    });

    // Remove injected stylesheets
    document.querySelectorAll('link[data-font], style[data-font]').forEach(el => {
      if (el.getAttribute('data-font') !== 'default') {
        el.remove();
      }
    });
    
    // Reset loaded fonts map
    this.loadedFonts.clear();
    this.loadedFonts.set('default', {
      name: 'default',
      loaded: true,
      loading: false,
      error: null,
    });
  }
}

// Export singleton instance
export const FontManager = FontManagerClass.getInstance();

// Export type for the class
export type FontManagerType = FontManagerClass;
