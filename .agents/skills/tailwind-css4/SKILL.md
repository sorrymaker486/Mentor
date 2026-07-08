---
name: tailwind-css4
description: Tailwind CSS 4 best practices for this project. Covers the @tailwindcss/vite plugin, CSS-first configuration, custom dp2-* design system classes, utility usage patterns, responsive design, and how custom CSS files (*.css, *.module.css) coexist with Tailwind utilities. Use when adding or modifying any UI styling in frontend/src/.
---

# Tailwind CSS 4 (Vite Plugin)

This project uses **Tailwind CSS 4** via `@tailwindcss/vite` (NOT PostCSS plugin). The configuration is CSS-first, not JS-based. The `tailwind.config.js` file uses the legacy v3 format for `tailwindcss-animate` and `@tailwindcss/typography` plugins.

## Project Setup

```js
// vite.config.js
import tailwindcss from '@tailwindcss/vite'
export default {
  plugins: [react(), tailwindcss()],
}
```

```js
// tailwind.config.js — legacy format for plugins
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
}
```

Tailwind CSS 4 uses CSS-based configuration via `@theme` in the main CSS entry. No `tailwind.config.js` needed for theme values — only plugins use the JS config.

## Custom Design System (dp2-* Classes)

The project uses a custom CSS class prefix `dp2-` for design system components. These are defined in `App.css` and `DesignPreview.css`. These custom classes coexist with Tailwind utilities:

```jsx
// Mixing dp2-* with Tailwind utilities:
<button className="dp2-button" type="button">
  <span>{children}</span>
</button>

<section className="dp2-stage dp2-stage-default">
  <div className="dp2-stage-inner">{children}</div>
</section>

<div className="relative group my-4">
  <button className="absolute right-2 top-2 z-10 rounded-sm border border-[#1a1f24]/10 bg-white/90 px-2.5 py-1 text-[11px] font-medium tracking-wide text-[#1a1f24]/70 shadow-sm transition-all hover:bg-white opacity-0 group-hover:opacity-100">
    {copied ? '已复制' : '复制'}
  </button>
</div>
```

### When to Use dp2-* vs Tailwind

- **dp2-* classes**: Complex layout components (stage, panel, toolbar, button, field), reusable design system pieces
- **Tailwind utilities**: Spacing, typography, colors, positioning, interactive states, one-off styling needs

## Key Utility Patterns from the Codebase

### Color with opacity modifiers
```
bg-[#1a1f24]/10    → background with 10% opacity
bg-white/90         → white with 90% opacity
border-[#1a1f24]/10 → border with 10% opacity
```

### Arbitrary values
```
text-[11px]         → explicit font size
max-w-[min(100%,280px)] → CSS min() in arbitrary value
```

### Group hover
```
opacity-0 group-hover:opacity-100  → hidden by default, shown on parent hover
```

### Responsive: not extensively used
The project primarily targets desktop. Use responsive prefixes sparingly and only when needed for mobile support.

### Transitions and animations
```
transition-all         → animate all properties
transition duration-300 → custom duration
animate-pulse          → built-in pulse animation
```

## CSS Files Structure

```
frontend/src/
  index.css          → global styles + Tailwind directives
  App.css            → main app styles, dp2-* design system
  components/
    DesignPreview.css     → dp2-stage, dp2-button, dp2-field styles
    IntroLoader.module.css → CSS Modules for scoped styles
    hero-motion/
      heroMotion.module.css → scoped module styles
```

### CSS Modules (`.module.css`)
Used for scoped component styles. Import and use as an object:
```jsx
import styles from './IntroLoader.module.css';
<div className={styles.container}>...</div>
```

## Constraints

### MUST DO
- Use dp2-* classes for existing design system components (don't recreate them with raw Tailwind)
- Use Tailwind utilities for spacing, colors, typography, not inline styles
- Keep custom CSS in the appropriate `.css` or `.module.css` file
- Use `@apply` sparingly — prefer composing utility classes in JSX

### MUST NOT DO
- Mix dp2-* and competing Tailwind layout on the same element (e.g., don't add `dp2-button` + `flex` + `py-2`)
- Use inline `style={{}}` objects when a Tailwind equivalent exists
- Create new CSS files without checking if existing dp2-* classes already handle the need
- Override dp2-* styles with `!important` — fix the source definition instead
- Use Tailwind v3 `@layer` directives (not supported in v4)

## Typography Plugin

`@tailwindcss/typography` is available. Use `prose` classes for rich text content:
```jsx
<div className="prose prose-sm max-w-none prose-invert">
  <ReactMarkdown>{text}</ReactMarkdown>
</div>
```

Available modifiers: `prose-sm`, `prose-invert`, `max-w-none`, `prose-headings:`, etc.
