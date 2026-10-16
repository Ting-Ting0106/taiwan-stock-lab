import { resolve } from 'node:path';
import { z } from 'zod';

export const instance = process.argv.includes('--codex') ? 'codex' : 'user';
export const port = z.coerce.number().int().min(1024).max(65535).parse(process.env.PORT ?? (instance === 'codex' ? 3101 : 3100));
export const base = `http://127.0.0.1:${port}`;
export const dataDirectory = resolve(process.env.DATA_DIR ?? (instance === 'codex' ? 'data/codex' : 'data'));
export const staticDirectory = resolve(process.env.STATIC_DIR ?? (instance === 'codex' ? 'dist-codex' : 'dist'));
export const devOrigin = `http://127.0.0.1:${instance === 'codex' ? 5174 : 5173}`;
// Cookies share a hostname across ports; distinct names prevent login attempts colliding.
export const oauthCookie = `stock_oauth_${port}`;
