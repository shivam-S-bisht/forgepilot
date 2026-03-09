import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
	entry: ['index.ts', 'mcp-server.ts'],
	format: ['esm'],
	platform: 'node',
	target: 'node20',
	outDir: 'dist',
	clean: !options.watch,
	sourcemap: false,
	splitting: false,
	bundle: true,
	treeshake: true,
	minify: !options.watch,
	keepNames: false,
	outExtension: () => ({ js: '.js' }),
	external: ['sherpa-onnx-node'],
	esbuildOptions(buildOptions) {
		buildOptions.define = {
			...(buildOptions.define ?? {}),
			'process.env.NODE_ENV': JSON.stringify(options.watch ? 'development' : 'production'),
		};
	},
}));
