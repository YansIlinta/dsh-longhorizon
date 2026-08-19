import { defineConfig } from 'tsdown'

/** Build the package root, controller, runner, and invariant as independent bundles. */
export default defineConfig([
  {
    entry: ['lib/types/index.js', 'lib/types/controller.js', 'lib/types/runner.js', 'lib/types/invariant.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
