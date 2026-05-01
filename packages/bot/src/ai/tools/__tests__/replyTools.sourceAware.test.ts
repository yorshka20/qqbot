import { describe, expect, it } from 'bun:test';
import { filterToolsForReply } from '@/ai/tools/replyTools';
import type { ToolSpec } from '@/tools/types';

// Synthetic ToolSpec fixtures matching migrated real-IM tool visibility.
// Subagent-only/internal specs are included for completeness — they should
// never appear in filterToolsForReply output.

const research: ToolSpec = {
  name: 'research',
  description: 'x',
  executor: 'research',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'] } },
};
const format_as_card: ToolSpec = {
  name: 'format_as_card',
  description: 'x',
  executor: 'format_as_card',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'] } },
};
const list_bot_features: ToolSpec = {
  name: 'list_bot_features',
  description: 'x',
  executor: 'list_bot_features',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'] }, subagent: true },
};
const get_memory: ToolSpec = {
  name: 'get_memory',
  description: 'x',
  executor: 'get_memory',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord', 'avatar-cmd'] }, subagent: true },
};
const read_file: ToolSpec = {
  name: 'read_file',
  description: 'x',
  executor: 'read_file',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'], adminOnly: true }, subagent: true },
};
const fetch_image: ToolSpec = {
  name: 'fetch_image',
  description: 'x',
  executor: 'fetch_image',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'] } },
};
const search_chat_history: ToolSpec = {
  name: 'search_chat_history',
  description: 'x',
  executor: 'search_chat_history',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord', 'avatar-cmd'] } },
};
const search_code: ToolSpec = {
  name: 'search_code',
  description: 'x',
  executor: 'search_code',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'], adminOnly: true }, subagent: true },
};
const execute_command: ToolSpec = {
  name: 'execute_command',
  description: 'x',
  executor: 'execute_command',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'], adminOnly: true } },
};
const analyze_video: ToolSpec = {
  name: 'analyze_video',
  description: 'x',
  executor: 'analyze_video',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'] }, subagent: true },
};
const execute_code: ToolSpec = {
  name: 'execute_code',
  description: 'x',
  executor: 'execute_code',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'], adminOnly: true }, subagent: true },
};
const bilibili: ToolSpec = {
  name: 'bilibili',
  description: 'x',
  executor: 'bilibili',
  visibility: { reply: { sources: ['qq-private', 'qq-group', 'discord'] }, subagent: true },
};

// Subagent-only — should never appear in reply filter
const fetch_page: ToolSpec = {
  name: 'fetch_page',
  description: 'x',
  executor: 'fetch_page',
  visibility: { subagent: true },
};
const get_group_member_list: ToolSpec = {
  name: 'get_group_member_list',
  description: 'x',
  executor: 'get_group_member_list',
  visibility: { subagent: true },
};

// Internal — should never appear in reply filter
const deduplicate_files: ToolSpec = {
  name: 'deduplicate_files',
  description: 'x',
  executor: 'deduplicate_files',
  visibility: { internal: true },
};

const ALL_SPECS: ToolSpec[] = [
  research,
  format_as_card,
  list_bot_features,
  get_memory,
  read_file,
  fetch_image,
  search_chat_history,
  search_code,
  execute_command,
  analyze_video,
  execute_code,
  bilibili,
  fetch_page,
  get_group_member_list,
  deduplicate_files,
];

const ADMIN_TOOLS = ['execute_command', 'execute_code', 'read_file', 'search_code'];
const AVATAR_CMD_TOOLS = ['get_memory', 'search_chat_history'];

function names(specs: ToolSpec[]): string[] {
  return specs.map((s) => s.name);
}

describe('filterToolsForReply — source/admin aware', () => {
  it('qq-private admin sees all real-IM tools including admin-only', () => {
    const out = filterToolsForReply(ALL_SPECS, 'qq-private', true);
    const outNames = names(out);
    expect(outNames).toContain('research');
    expect(outNames).toContain('format_as_card');
    expect(outNames).toContain('fetch_image');
    for (const n of ADMIN_TOOLS) expect(outNames).toContain(n);
    // subagent-only and internal absent
    expect(outNames).not.toContain('fetch_page');
    expect(outNames).not.toContain('get_group_member_list');
    expect(outNames).not.toContain('deduplicate_files');
  });

  it('qq-private non-admin hides admin-only tools', () => {
    const out = filterToolsForReply(ALL_SPECS, 'qq-private', false);
    const outNames = names(out);
    for (const n of ADMIN_TOOLS) expect(outNames).not.toContain(n);
    expect(outNames).toContain('research');
    expect(outNames).toContain('format_as_card');
    expect(outNames).toContain('fetch_image');
  });

  it('qq-group non-admin sees non-admin real-IM tools', () => {
    const out = filterToolsForReply(ALL_SPECS, 'qq-group', false);
    const outNames = names(out);
    for (const n of ADMIN_TOOLS) expect(outNames).not.toContain(n);
    expect(outNames).toContain('research');
    expect(outNames).toContain('list_bot_features');
  });

  it('get_group_member_list is subagent-only, absent in reply', () => {
    const out = filterToolsForReply(ALL_SPECS, 'qq-group', true);
    const outNames = names(out);
    expect(outNames).not.toContain('get_group_member_list');
  });

  it('avatar-cmd sees only tools with avatar-cmd allowlist', () => {
    const out = filterToolsForReply(ALL_SPECS, 'avatar-cmd', true);
    const outNames = names(out);
    for (const n of AVATAR_CMD_TOOLS) expect(outNames).toContain(n);
    expect(outNames).not.toContain('research');
    expect(outNames).not.toContain('format_as_card');
    expect(outNames).not.toContain('fetch_image');
    for (const n of ADMIN_TOOLS) expect(outNames).not.toContain(n);
  });

  it('bilibili-danmaku returns empty (no tool lists that source)', () => {
    const out = filterToolsForReply(ALL_SPECS, 'bilibili-danmaku', true);
    expect(out).toEqual([]);
  });

  it('idle-trigger returns empty (no tool lists that source)', () => {
    const out = filterToolsForReply(ALL_SPECS, 'idle-trigger', true);
    expect(out).toEqual([]);
  });

  it('bootstrap returns empty (no tool lists that source)', () => {
    const out = filterToolsForReply(ALL_SPECS, 'bootstrap', true);
    expect(out).toEqual([]);
  });
});
