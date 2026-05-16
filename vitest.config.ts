import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // co-location: test files next to source files
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/types.ts', 'src/core/**/*.test.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
    // clear mocks between tests
    clearMocks: true,
  },
});
