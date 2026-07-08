---
name: react-spa-patterns
description: Client-side React 19 SPA patterns for this project. Covers hooks (useState, useEffect, useRef, useMemo, useCallback, React.memo), component composition, streaming SSE data, error handling, regex-based validation, intersection observer scroll reveals, and complex state management without external libraries. Use when editing any .jsx file in frontend/src/.
---

# React 19 SPA Patterns (Vite Client-Side)

This project is a pure client-side React 19 SPA built with Vite. No SSR, no Next.js, no Server Components. All rendering happens in the browser.

## Component Structure Convention

All components live in `frontend/src/components/`. The main `App.jsx` at `frontend/src/App.jsx` is a large single-file app containing login, learning studio, resource workspace, and all sub-views. Helper components (CodeBlock, Reveal, V29PageShell, V29Button, etc.) are defined in the same file as internal functions.

When adding new components, prefer co-locating small helper components in the same file, and extract larger reusable pieces to `frontend/src/components/` with a `.jsx` extension.

## Hooks Usage (from App.jsx patterns)

### useState
```jsx
const [value, setValue] = useState(initialValue);
const [loading, setLoading] = useState(false);
const [errorMsg, setErrorMsg] = useState('');
```
Set initial state from a function to avoid re-evaluation:
```jsx
const [width, setWidth] = useState(() => window.innerWidth);
```

### useRef — DOM refs and mutable values
```jsx
const passwordRef = useRef(null);    // DOM element ref
const abortRef = useRef(null);       // AbortController holder
const userTouchedRef = useRef(false); // Mutable flag (no re-render)
```

### useEffect — side effects with cleanup
Always return a cleanup function for subscriptions, observers, and timers:
```jsx
useEffect(() => {
  let cancelled = false;
  fetch(url).then((r) => r.json()).then((j) => {
    if (!cancelled && r.ok) setData(j);
  });
  return () => { cancelled = true; };
}, [url]);

useEffect(() => {
  const el = ref.current;
  if (!el) return undefined;
  const io = new IntersectionObserver(
    ([e]) => { if (e?.isIntersecting) callback(); },
    { threshold: 0.05 }
  );
  io.observe(el);
  return () => io.disconnect();
}, []);
```

### useMemo — expensive computations
```jsx
const resourceEntries = useMemo(() => {
  const apiTypes = overview?.resource_types;
  if (!apiTypes) return fallback;
  return Object.entries(apiTypes).map(([key, value]) => ({ key, title: value?.title }));
}, [overview]);
```

### React.memo — prevent re-renders for pure components
```jsx
const V29LearningMap = React.memo(function V29LearningMap({ profile = {} }) {
  // ...
});
```

### useCallback — not used in this codebase
The project does NOT use `useCallback`. Do not introduce it unless there is a measurable performance issue with stable callback references passed to memoized children.

## Streaming SSE Data

The project reads server-sent streaming responses from the FastAPI backend:

```jsx
const reader = r.body.getReader();
const decoder = new TextDecoder();
let acc = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  acc += decoder.decode(value, { stream: true });
  setResourceDrafts((prev) => ({ ...prev, [key]: { text: acc, err: '' } }));
}
acc += decoder.decode(); // flush
```

Key pattern: accumulate text and update state on every chunk for real-time UI updates. Use `{ stream: true }` for multi-byte character safety.

## AbortController Pattern

For cancellable fetch requests:

```jsx
const abortRef = useRef(null);

const startFetch = async () => {
  try { abortRef.current?.abort(); } catch { /* ignore */ }
  const ac = new AbortController();
  abortRef.current = ac;

  try {
    const r = await fetch(url, { signal: ac.signal, ... });
    // stream reading...
  } catch (e) {
    if (e?.name !== 'AbortError') {
      setError(e?.message || 'failed');
    }
  }
};
```

Clean up on unmount:
```jsx
return () => {
  try { abortRef.current?.abort(); } catch { /* ignore */ }
};
```

## Regex Validation

Username: 2-16 chars, Chinese/English/digits/underscore
```js
const USERNAME_PATTERN = /^[\u3400-\u4DBF\u4E00-\u9FFFA-Za-z0-9_]{2,16}$/;
```

Password (registration): 6-20 chars, must include uppercase + lowercase + digit
```js
const passwordRegisterRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9]{6,20}$/;
```

## State Dependencies and Effect Timing

The codebase chains effects through state changes. When one effect depends on another's result, use a separate state variable:

```jsx
// Effect 1: fetch overview → sets overview state
useEffect(() => { fetch overview }, [apiBase]);

// Effect 2: react to overview changes → update resource entries
const resourceEntries = useMemo(() => compute from overview, [overview]);

// Effect 3: react to entries changes → auto-select first entry
useEffect(() => {
  if (!resourceEntries.some(e => e.key === activeKey)) {
    setActiveKey(resourceEntries[0].key);
  }
}, [resourceEntries, activeKey]);
```

## Error and Edge Cases

- Always use optional chaining: `r?.body`, `data?.detail`
- Always provide fallbacks: `profile[axis.key] ?? axis.base`
- Always filter nulls: `links = items.map(...).filter(Boolean)`
- Handle AbortError separately from real errors
- Use `try { JSON.parse() } catch { /* fallback */ }` for parsing API responses

## Constraints

### MUST DO
- Use functional (not class) components
- Clean up effects (timers, observers, abort controllers)
- Use stable keys for lists (never array index for dynamic lists)
- Sanitize user input before sending to API (`sanitizeUsername`)
- Check `r.ok` before reading response body
- Handle AbortError gracefully

### MUST NOT DO
- Use useCallback without a measurable performance reason
- Mutate state directly; always use setter functions
- Introduce external state management libraries (Redux, Zustand)
- Throw raw errors without try/catch around async operations
- Create functions inside JSX render props without memoization when passed to memoized components

## Imports Convention

```jsx
import React, { useState, useRef, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { API_BASE } from './apiConfig';
```

Always import `React` explicitly (even though React 19 JSX transform doesn't require it — the codebase does it consistently).
