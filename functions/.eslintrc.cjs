module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:import/errors',
    'plugin:import/warnings',
    'plugin:import/typescript',
    'google',
    'plugin:@typescript-eslint/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: ['tsconfig.json', 'tsconfig.dev.json'],
    sourceType: 'module',
  },
  ignorePatterns: [
    '/lib/**/*', // Ignore built files.
  ],
  plugins: ['@typescript-eslint', 'import'],
  rules: {
    'max-len': 'off',
    'linebreak-style': 'off',
    'object-curly-spacing': 'off',
    'import/no-unresolved': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    indent: 'off',
    'no-unused-vars': 'off',
  },
};
