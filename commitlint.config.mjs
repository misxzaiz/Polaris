/**
 * commitlint configuration
 * @see https://commitlint.js.org/
 * @see https://www.conventionalcommits.org/
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Type enum - allowed commit types
    'type-enum': [
      2,
      'always',
      [
        'feat',     // New feature
        'fix',      // Bug fix
        'docs',     // Documentation changes
        'style',    // Code style changes (formatting, etc.)
        'refactor', // Code refactoring
        'perf',     // Performance improvements
        'test',     // Adding or modifying tests
        'build',    // Build system changes
        'ci',       // CI configuration changes
        'chore',    // Other changes that don't modify src or test files
        'revert',   // Reverts a previous commit
      ],
    ],
    // Subject must not end with a period
    'subject-full-stop': [2, 'never', '.'],
    // Subject case - use lowercase
    'subject-case': [2, 'always', 'lower-case'],
    // Body must have leading blank line
    'body-leading-blank': [2, 'always'],
    // Footer must have leading blank line
    'footer-leading-blank': [2, 'always'],
    // Header max length
    'header-max-length': [2, 'always', 100],
  },
};
