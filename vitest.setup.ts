/**
 * Vitest global setup. Loaded via `setupFiles` in vitest.config.ts.
 *
 * Extends `expect` with `@testing-library/jest-dom` matchers
 * (`toBeInTheDocument`, `toHaveTextContent`, etc.) for any test that
 * opts into the jsdom environment via the per-file directive
 * `// @vitest-environment jsdom`. Node-env tests are unaffected — the
 * matchers tolerate a missing DOM and only register their assertions.
 *
 * Auto-cleanup between tests: `@testing-library/react`'s `cleanup` doesn't
 * auto-register against vitest's afterEach the way it does with Jest, so
 * we wire it explicitly. Without this, sequential `render()` calls leak
 * their trees into each other and queries find ghost elements.
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(() => {
  cleanup();
});
