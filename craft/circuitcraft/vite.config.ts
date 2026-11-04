import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	// the PSpice translator is shared with the MCP CLI and lives next to this folder (../pspice)
	server: { fs: { allow: ['..'] } },
	// the engine worker is an ES module (top-level await, a 19 MB inlined WASM)
	worker: { format: 'es' },
	build: { chunkSizeWarningLimit: 25000 }
});
