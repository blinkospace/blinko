# Font Customization Guide

## Overview
The font switcher allows users to change the entire app's font family. This guide explains how the system works and how to add custom fonts.

## How It Works

### 1. Font Storage & Application
- Selected font is stored in the database via `defaultFont` config key
- On selection, font is applied to `document.body.style.fontFamily`
- On app initialization, saved font is loaded from config and reapplied

### 2. Font Flow
```
User selects font → 
  Save to database (api.config.update) → 
    Apply to document.body → 
      On app reload: Load from config → Apply to body
```

## Adding Custom Fonts

### Method 1: Google Fonts (Recommended)

1. **Add Google Fonts import to `app/index.html`:**
```html
<head>
  <!-- Add before closing </head> tag -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Roboto:wght@300;400;500;700&family=Montserrat:wght@300;400;500;600;700&family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
</head>
```

2. **Add font to the fonts array in `app/src/store/baseStore.ts`:**
```typescript
fonts = [
  { fontname: "default", displayName: "Default (System)" },
  { fontname: "Inter", displayName: "Inter" },
  { fontname: "Your New Font", displayName: "Your New Font Name" },
  // ... other fonts
]
```

### Method 2: Local Font Files

1. **Add font files to `app/public/fonts/` directory:**
```
app/public/fonts/
  ├── YourFont-Regular.woff2
  ├── YourFont-Bold.woff2
  └── YourFont-Italic.woff2
```

2. **Add @font-face declarations to `app/src/styles/globals.css`:**
```css
@font-face {
  font-family: 'Your Font Name';
  src: url('/fonts/YourFont-Regular.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'Your Font Name';
  src: url('/fonts/YourFont-Bold.woff2') format('woff2');
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
```

3. **Add to fonts array in `baseStore.ts`:**
```typescript
{ fontname: "Your Font Name", displayName: "Your Font Name" }
```

### Method 3: System Fonts

For fonts already installed on most systems (no download needed):

```typescript
fonts = [
  { fontname: "default", displayName: "Default (System)" },
  { fontname: "Arial", displayName: "Arial" },
  { fontname: "Helvetica", displayName: "Helvetica" },
  { fontname: "Times New Roman", displayName: "Times New Roman" },
  { fontname: "Georgia", displayName: "Georgia (Serif)" },
  { fontname: "Courier New", displayName: "Courier New (Mono)" },
  { fontname: "Verdana", displayName: "Verdana" },
]
```

## Font Fallback Stack

For better cross-platform compatibility, use font stacks:

```typescript
{ 
  fontname: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", 
  displayName: "Inter" 
}
```

## Best Practices

1. **Performance:**
   - Use `woff2` format for best compression
   - Add `font-display: swap` to prevent text blocking
   - Preload critical fonts: `<link rel="preload" as="font" href="/fonts/font.woff2" crossorigin>`

2. **Fallbacks:**
   - Always include system fallbacks in fontFamily
   - Test on multiple platforms (Windows, Mac, Linux)

3. **Font Weights:**
   - Include multiple weights (300, 400, 500, 600, 700) for consistency
   - Not all fonts support all weights

4. **Licensing:**
   - Check font licenses before use
   - Google Fonts are open source
   - Commercial fonts may require licenses

## Variable Fonts (Advanced)

For modern browsers, use variable fonts for better control:

```css
@font-face {
  font-family: 'Inter Variable';
  src: url('/fonts/Inter-Variable.woff2') format('woff2-variations');
  font-weight: 100 900;
  font-display: swap;
}
```

## Testing Your Font

1. Select the font in Settings → Preference → Font Style
2. Check that text renders correctly across:
   - Cards and notes
   - Settings menu
   - Editor
   - Navigation
   - Different font sizes

## Troubleshooting

**Font not showing:**
- Check browser console for 404 errors
- Verify font file path is correct
- Ensure @font-face syntax is correct
- Clear browser cache

**Font looks different than expected:**
- Check font-weight is correctly specified
- Verify font file includes required weights
- Test with different font-display values

**Performance issues:**
- Reduce number of font weights loaded
- Use font subsetting for smaller file sizes
- Enable font compression on server
