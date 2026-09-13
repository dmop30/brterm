import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // サーバ
    files: ['src/server/**/*.ts', 'src/shared/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // 画面
    files: ['src/client/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: reactHooks.configs.flat['recommended-latest'].plugins,
    rules: reactHooks.configs.flat['recommended-latest'].rules,
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // 未使用は _ 始まりだけ許す
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 秘密情報をログに出さない方針のため、console は warn/error に限る
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Buffer']",
          message: 'new Buffer は使わない。Buffer.from / Buffer.alloc を使う。',
        },
      ],
    },
  },
  {
    files: ['vite.config.ts', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
);
