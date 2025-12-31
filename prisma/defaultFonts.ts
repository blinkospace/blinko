/**
 * Default fonts configuration for Blinko
 * These fonts are seeded into the database during initial setup
 */

export type FontSeed = {
  name: string;
  displayName: string;
  url: string | null;
  fileData: Uint8Array | null;
  isLocal: boolean;
  weights: number[];
  category: string;
  isSystem: boolean;
  sortOrder: number;
};

/**
 * System default font - uses browser's native font stack
 */
export const systemDefaultFont: FontSeed = {
  name: 'default',
  displayName: 'Default (System)',
  url: null,
  fileData: null,
  isLocal: false,
  weights: [400, 500, 600, 700],
  category: 'sans-serif',
  isSystem: true,
  sortOrder: 0,
};

/**
 * CDN-based fonts loaded via external CSS URLs
 * These fonts don't require local file storage
 */
export const cdnFonts: FontSeed[] = [
  // === Modern & Minimal Sans-Serif ===
  {
    name: 'Inter',
    displayName: 'Inter',
    url: 'https://fonts.cdnfonts.com/css/inter',
    fileData: null,
    isLocal: false,
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    category: 'sans-serif',
    isSystem: false,
    sortOrder: 100,
  },
  {
    name: 'Open Sans',
    displayName: 'Open Sans',
    url: 'https://fonts.cdnfonts.com/css/open-sans',
    fileData: null,
    isLocal: false,
    weights: [300, 400, 600, 700, 800],
    category: 'sans-serif',
    isSystem: false,
    sortOrder: 101,
  },
  {
    name: 'Poppins',
    displayName: 'Poppins',
    url: 'https://fonts.cdnfonts.com/css/poppins',
    fileData: null,
    isLocal: false,
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    category: 'sans-serif',
    isSystem: false,
    sortOrder: 102,
  },
  {
    name: 'Montserrat',
    displayName: 'Montserrat',
    url: 'https://fonts.cdnfonts.com/css/montserrat',
    fileData: null,
    isLocal: false,
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    category: 'sans-serif',
    isSystem: false,
    sortOrder: 103,
  },
  {
    name: 'Nunito',
    displayName: 'Nunito',
    url: 'https://fonts.cdnfonts.com/css/nunito',
    fileData: null,
    isLocal: false,
    weights: [200, 300, 400, 500, 600, 700, 800, 900],
    category: 'sans-serif',
    isSystem: false,
    sortOrder: 104,
  },
  {
    name: 'Raleway',
    displayName: 'Raleway',
    url: 'https://fonts.cdnfonts.com/css/raleway-5',
    fileData: null,
    isLocal: false,
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    category: 'sans-serif',
    isSystem: false,
    sortOrder: 105,
  },
  {
    name: 'Manrope',
    displayName: 'Manrope',
    url: 'https://fonts.cdnfonts.com/css/manrope',
    fileData: null,
    isLocal: false,
    weights: [200, 300, 400, 500, 600, 700, 800],
    category: 'sans-serif',
    isSystem: false,
    sortOrder: 106,
  },
  {
    name: 'Space Grotesk',
    displayName: 'Space Grotesk',
    url: 'https://fonts.cdnfonts.com/css/space-grotesk',
    fileData: null,
    isLocal: false,
    weights: [300, 400, 500, 600, 700],
    category: 'sans-serif',
    isSystem: false,
    sortOrder: 107,
  },
  {
    name: 'DM Sans',
    displayName: 'DM Sans',
    url: 'https://fonts.cdnfonts.com/css/dm-sans',
    fileData: null,
    isLocal: false,
    weights: [400, 500, 700],
    category: 'sans-serif',
    isSystem: false,
    sortOrder: 108,
  },
  {
    name: 'Plus Jakarta Sans',
    displayName: 'Plus Jakarta Sans',
    url: 'https://fonts.cdnfonts.com/css/plus-jakarta-sans',
    fileData: null,
    isLocal: false,
    weights: [200, 300, 400, 500, 600, 700, 800],
    category: 'sans-serif',
    isSystem: false,
    sortOrder: 109,
  },
  {
    name: 'Outfit',
    displayName: 'Outfit',
    url: 'https://fonts.cdnfonts.com/css/outfit',
    fileData: null,
    isLocal: false,
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    category: 'sans-serif',
    isSystem: false,
    sortOrder: 110,
  },
  {
    name: 'JetBrains Mono',
    displayName: 'JetBrains Mono',
    url: 'https://fonts.cdnfonts.com/css/jetbrains-mono-2',
    fileData: null,
    isLocal: false,
    weights: [100, 200, 300, 400, 500, 600, 700, 800],
    category: 'monospace',
    isSystem: false,
    sortOrder: 200,
  },
  {
    name: 'Fira Code',
    displayName: 'Fira Code',
    url: 'https://fonts.cdnfonts.com/css/fira-code',
    fileData: null,
    isLocal: false,
    weights: [300, 400, 500, 600, 700],
    category: 'monospace',
    isSystem: false,
    sortOrder: 201,
  },
  {
    name: 'Source Code Pro',
    displayName: 'Source Code Pro',
    url: 'https://fonts.cdnfonts.com/css/source-code-pro',
    fileData: null,
    isLocal: false,
    weights: [200, 300, 400, 500, 600, 700, 900],
    category: 'monospace',
    isSystem: false,
    sortOrder: 202,
  },
  {
    name: 'Space Mono',
    displayName: 'Space Mono',
    url: 'https://fonts.cdnfonts.com/css/space-mono',
    fileData: null,
    isLocal: false,
    weights: [400, 700],
    category: 'monospace',
    isSystem: false,
    sortOrder: 204,
  },
  {
    name: 'Roboto Mono',
    displayName: 'Roboto Mono',
    url: 'https://fonts.cdnfonts.com/css/roboto-mono',
    fileData: null,
    isLocal: false,
    weights: [100, 200, 300, 400, 500, 600, 700],
    category: 'monospace',
    isSystem: false,
    sortOrder: 205,
  },
  {
    name: 'Ubuntu Mono',
    displayName: 'Ubuntu Mono',
    url: 'https://fonts.cdnfonts.com/css/ubuntu-mono',
    fileData: null,
    isLocal: false,
    weights: [400, 700],
    category: 'monospace',
    isSystem: false,
    sortOrder: 206,
  },
  {
    name: 'Inconsolata',
    displayName: 'Inconsolata',
    url: 'https://fonts.cdnfonts.com/css/inconsolata',
    fileData: null,
    isLocal: false,
    weights: [200, 300, 400, 500, 600, 700, 800, 900],
    category: 'monospace',
    isSystem: false,
    sortOrder: 207,
  },
  {
    name: 'Anonymous Pro',
    displayName: 'Anonymous Pro',
    url: 'https://fonts.cdnfonts.com/css/anonymous-pro',
    fileData: null,
    isLocal: false,
    weights: [400, 700],
    category: 'monospace',
    isSystem: false,
    sortOrder: 208,
  },
  {
    name: 'VT323',
    displayName: 'VT323 (Retro)',
    url: 'https://fonts.cdnfonts.com/css/vt323',
    fileData: null,
    isLocal: false,
    weights: [400],
    category: 'monospace',
    isSystem: false,
    sortOrder: 209,
  },
  {
    name: 'Share Tech Mono',
    displayName: 'Share Tech Mono',
    url: 'https://fonts.cdnfonts.com/css/share-tech-mono',
    fileData: null,
    isLocal: false,
    weights: [400],
    category: 'monospace',
    isSystem: false,
    sortOrder: 211,
  },
];

/**
 * Get all default fonts (system + CDN)
 */
export function getDefaultFonts(): FontSeed[] {
  return [systemDefaultFont, ...cdnFonts];
}
