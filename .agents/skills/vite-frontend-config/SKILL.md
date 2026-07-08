---
name: vite-frontend-config
description: Vite 8 configuration and build patterns for this project. Covers dev server proxy, environment variables (VITE_*), optimizeDeps, ESM imports, and the @vitejs/plugin-react + @tailwindcss/vite plugin combo. Use when modifying vite.config.js or build/dependency configuration.
---

# Vite 8 Frontend Configuration

This project uses Vite 8 as the build tool and dev server for the React frontend.

## Project Config (vite.config.js)

```js
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_PROXY_TARGET || 'http://127.0.0.1:8001'
  const apiProxy = {
    '/api': {
      target,
      changeOrigin: true,
      rewrite: (path) => {
        const stripped = path.replace(/^\/api/, '')
        return stripped === '' ? '/' : stripped
      },
    },
  }

  return {
    plugins: [react(), tailwindcss()],
    optimizeDeps: {
      include: ['mermaid'],
    },
    server: { proxy: apiProxy },
    preview: { proxy: apiProxy },
  }
})
```

## API Proxy

The dev server proxies `/api/*` requests to the FastAPI backend at `http://127.0.0.1:8001`. The proxy strips the `/api` prefix before forwarding:

- `/api/learning/studio/overview` → `http://127.0.0.1:8001/learning/studio/overview`

Override the target with `VITE_PROXY_TARGET` env var if needed.

## Environment Variables

Only variables prefixed with `VITE_` are exposed to client code via `import.meta.env`:

```
VITE_API_BASE=/api          # API base URL (defaults to /api if not set)
VITE_PROXY_TARGET=http://127.0.0.1:8001  # Backend proxy target
```

```js
// frontend/src/apiConfig.js
const raw = (import.meta.env.VITE_API_BASE ?? '').trim();
export const API_BASE = raw !== '' ? stripTrailingSlashes(raw) : '/api';
```

When adding new env vars, always prefix with `VITE_` and document them.

## Dependencies Optimization

`optimizeDeps.include` pre-bundles specified dependencies:

```js
optimizeDeps: {
  include: ['mermaid'],
},
```

Add libraries here if they cause slow cold starts or import resolution issues. Only add packages that actually need pre-bundling — overusing this slows initial dev server startup.

## ESM (type: module)

`package.json` has `"type": "module"`. This means:
- `import`/`export` syntax (no `require`)
- `.js` files are treated as ESM
- No `__dirname` or `__filename` (use `import.meta.url` instead)

## Plugin Notes

### @vitejs/plugin-react
Provides React Fast Refresh (HMR without losing component state), JSX transform, and React 19 support.

### @tailwindcss/vite
Tailwind CSS 4 Vite plugin. Replaces the PostCSS plugin from v3. No PostCSS config needed for Tailwind. The `postcss.config.js` in the project is for `autoprefixer` only.

## Build

```bash
npm run build    # vite build → outputs to frontend/dist/
npm run preview  # vite preview → serves built assets locally
```

The Dockerfile copies `frontend/dist/` into the Python backend for production serving.

## Constraints

### MUST DO
- Use `loadEnv()` for accessing env vars in vite.config.js
- Keep proxy config in sync between `server` and `preview` sections
- Test dev server proxy works before pushing changes
- Add large/challenging deps to `optimizeDeps.include` only when needed

### MUST NOT DO
- Hardcode backend URLs (use `VITE_PROXY_TARGET` or let proxy handle it)
- Use `require()` in JS files (project is ESM)
- Expose non-VITE_ prefixed env vars to client code
- Add `vite.config.js` to the Docker build context without the frontend/src changes it references
