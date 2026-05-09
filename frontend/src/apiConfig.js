function stripTrailingSlashes(s) {
  return s.replace(/\/+$/, '');
}

const raw = (import.meta.env.VITE_API_BASE ?? '').trim();

/**
 * 与 FastAPI 通信的根路径（无末尾斜杠）。
 * 未设置 VITE_API_BASE 时默认 `/api`，由 Vite 开发代理或生产环境反向代理转发到后端。
 * 直连后端时可设为 `http://127.0.0.1:8001`。
 */
export const API_BASE =
  raw !== '' ? stripTrailingSlashes(raw) : '/api';
