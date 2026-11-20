// CommonJS package: flat config loaded as ESM via the .mjs-compatible import below.
module.exports = import('@vip/config/eslint').then(({ createConfig }) =>
  createConfig({ typeImports: false, ignores: ['jest.config.js', 'eslint.config.js'] }),
);
