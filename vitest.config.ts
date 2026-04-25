import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  // React plugin handles JSX transform for `.test.tsx` files. Node-env tests
  // (the existing 973) don't import JSX, so the plugin is a no-op for them
  // — its cost is paid only on .tsx-test parse.
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules/**', '.next/**', 'dist/**'],
    // jsdom-env tests opt in via top-of-file `// @vitest-environment jsdom`
    // directive. The setup file extends `expect` with jest-dom matchers
    // for any test that renders React; node-env tests ignore it.
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      // Scope widens as each PR lands. PR-3 Chunk 1 covers regex + app schema.
      include: [
        'lib/store-submissions/regex/**/*.ts',
        'lib/store-submissions/schemas/app.ts',
        'lib/store-submissions/csv/**/*.ts',
        'lib/store-submissions/apps/**/*.ts',
      ],
      exclude: ['**/*.test.ts', '**/*.test.tsx'],
      thresholds: {
        lines: 95,
        functions: 100,
        statements: 95,
        branches: 85,
        'lib/store-submissions/regex/validators.ts': {
          lines: 100,
          functions: 100,
          statements: 100,
          branches: 100,
        },
        'lib/store-submissions/apps/alias-logic.ts': {
          lines: 100,
          functions: 100,
          statements: 100,
          branches: 100,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
