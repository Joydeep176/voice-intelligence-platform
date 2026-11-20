/** @type {import('jest').Config} */
const tsJest = ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }];

module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      rootDir: __dirname,
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
      transform: { '^.+\\.ts$': tsJest },
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      rootDir: __dirname,
      testMatch: ['<rootDir>/test/**/*.int-spec.ts'],
      transform: { '^.+\\.ts$': tsJest },
      testTimeout: 30000,
    },
  ],
};
