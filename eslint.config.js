import js from '@eslint/js';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default [
	{
		ignores: ['node_modules/**', 'dist/**', 'coverage/**'],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['**/*.js', '**/*.mjs', '**/*.cjs', '**/*.ts', '**/*.mts', '**/*.cts'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.node,
			},
		},
	},
	{
		files: ['**/*.ts', '**/*.mts', '**/*.cts'],
		rules: {
			'no-undef': 'off',
		},
	},
	eslintConfigPrettier,
];
