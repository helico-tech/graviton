import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Math members whose results are implementation-approximated and differ across engines (ADR-0002). */
export const BANNED_MATH = [
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
  'exp',
  'expm1',
  'log',
  'log1p',
  'log2',
  'log10',
  'pow',
  'hypot',
  'cbrt',
  'random',
];

/** @param {number} levelsUp how many `../` take a file out of src/sim */
function simImports(levelsUp) {
  return [
    'error',
    {
      patterns: [
        {
          group: [`${'../'.repeat(levelsUp)}*`],
          message: 'src/sim imports nothing outside itself (ADR-0002).',
        },
        { regex: '^[^./]', message: 'src/sim imports no packages (ADR-0002).' },
      ],
    },
  ];
}

export default defineConfig([
  globalIgnores([
    '.worktrees/',
    'docs/',
    'dist/',
    'node_modules/',
    'runs/',
    '.playwright-cli/',
    'test-results/',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    files: ['src/headless/**', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // Deterministic core: no transcendentals, no clocks, no platform globals, no outside imports.
    files: ['src/sim/**/*.ts'],
    ignores: ['**/*.test.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-properties': [
        'error',
        ...BANNED_MATH.map((property) => ({
          object: 'Math',
          property,
          message: `Math.${property} is not bit-identical across engines; see ADR-0002.`,
        })),
      ],
      'no-restricted-globals': [
        'error',
        'Date',
        'performance',
        'window',
        'document',
        'navigator',
        'requestAnimationFrame',
        'setTimeout',
        'setInterval',
        'crypto',
        'fetch',
        'localStorage',
        'Intl',
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "BinaryExpression[operator='**']", message: '** is Math.pow; see ADR-0002.' },
        {
          selector: "AssignmentExpression[operator='**=']",
          message: '** is Math.pow; see ADR-0002.',
        },
      ],
      'no-restricted-imports': simImports(1),
    },
  },
  // The import patterns match the specifier's text, not the resolved path, so the number of
  // `../` that leaves src/sim depends on the file's depth. Deeper files keep the strict default.
  ...[2, 3].map((depth) => ({
    files: [`src/sim/${'*/'.repeat(depth - 1)}*.ts`],
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-imports': simImports(depth) },
  })),
]);
