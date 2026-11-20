// Shared ESLint flat-config preset for TypeScript workspaces.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * @param {{ browser?: boolean, ignores?: string[], typeImports?: boolean }} [options]
 * `typeImports: false` for NestJS: `import type` would erase classes needed for DI metadata.
 */
export function createConfig(options = {}) {
  return tseslint.config(
    { ignores: ['dist/**', 'coverage/**', 'drizzle/**', ...(options.ignores ?? [])] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      languageOptions: {
        globals: options.browser ? globals.browser : globals.node,
      },
      rules: {
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/consistent-type-imports':
          options.typeImports === false ? 'off' : 'error',
        'no-console': 'error',
      },
    },
  );
}
