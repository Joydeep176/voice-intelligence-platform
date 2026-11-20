import { createConfig } from '@vip/config/eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  // shadcn/ui components are vendored generator output and are not linted.
  ...createConfig({
    browser: true,
    ignores: ['src/components/ui/**', 'playwright-report/**', 'test-results/**'],
  }),
  reactHooks.configs.flat['recommended-latest'] ?? reactHooks.configs.flat.recommended,
];
