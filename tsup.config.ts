import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: true,
  // Bundle the local workspace core so the published artifact is self-contained.
  noExternal: ['x402-casper-core'],
  banner: {
    js: '#!/usr/bin/env node'
  }
})
