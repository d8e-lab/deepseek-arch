#!/usr/bin/env node
/**
 * deepseek-arch — DeepSeek Terminal Agent 入口
 */

import { run } from './cli/index.js';

run().catch((err) => {
  console.error('致命错误:', err.message);
  process.exit(1);
});
