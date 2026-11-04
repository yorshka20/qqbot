import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fromRepoRoot } from '@qqbot/shared';
import { type ParseError, parse } from 'jsonc-parser';

describe('config.example.jsonc', () => {
  test('parses with the strictness the config loader uses, because worktrees boot from it', () => {
    const errors: ParseError[] = [];
    parse(readFileSync(fromRepoRoot('config.example.jsonc'), 'utf8'), errors);
    expect(errors).toEqual([]);
  });
});
