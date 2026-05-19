import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 测试文件统一在 tests/ 目录下，镜像 src/ 目录结构
    include: ['tests/**/*.test.ts'],
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
