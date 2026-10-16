import { defineConfig } from 'vite';
export default defineConfig(({ mode }) => {
  const codex = mode === 'codex';
  return {
    plugins: [{
      name: 'local-file-launcher',
      apply: 'build',
      transformIndexHtml: {
        order: 'post',
        handler: () => [{ tag: 'script', attrs: { src: './file-launcher.js' }, injectTo: 'head-prepend' }],
      },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'file-launcher.js', source: `if (window.location.protocol === 'file:') { window.location.replace('http://127.0.0.1:${codex ? 3101 : 3100}/'); }\n` });
      },
    }],
    build: { outDir: codex ? 'dist-codex' : 'dist' },
    server: { host: '127.0.0.1', port: codex ? 5174 : 5173, strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${codex ? 3101 : 3100}`, changeOrigin: true } } },
  };
});
