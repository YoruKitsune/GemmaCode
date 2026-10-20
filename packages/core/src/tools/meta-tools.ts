import { readdirSync } from 'node:fs';

import type { Tool } from './types.ts';

export const skillTool: Tool<{ name: string }> = {
  name: 'skill',
  description: 'Load the instructions of an installed skill by name.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Skill name' } },
    required: ['name'],
    additionalProperties: false,
  },
  risk: 'meta',
  inspect: (a) => ({ summary: `skill ${a.name}` }),
  async run(a, ctx) {
    const skill = ctx.skills?.get(a.name);
    if (!skill) {
      const names = ctx.skills?.list().map((s) => s.name).join(', ') || 'none';
      return { content: `No skill named "${a.name}". Installed skills: ${names}.`, isError: true };
    }
    let files = '';
    try {
      const extra = readdirSync(skill.dir).filter((f) => f !== 'SKILL.md');
      if (extra.length) files = `\n\nFiles next to this skill (in ${skill.dir}): ${extra.join(', ')}`;
    } catch {
      // каталога может не быть
    }
    return { content: `# Skill: ${skill.name}\n\n${skill.body}${files}`, untrusted: skill.scope === 'project' };
  },
};

export const todoTool: Tool<{ items: unknown[] }> = {
  name: 'todo',
  description: 'Write or update the task plan. Pass the full list: strings like "[ ] step" or "[x] done step".',
  parameters: {
    type: 'object',
    properties: { items: { type: 'array', description: 'All plan steps', items: { type: 'string' } } },
    required: ['items'],
    additionalProperties: false,
  },
  risk: 'meta',
  inspect: (a) => ({ summary: `plan (${a.items.length} steps)` }),
  async run(a, ctx) {
    ctx.todos = a.items.map((s) => String(s).trim()).filter(Boolean);
    return { content: `Plan saved:\n${ctx.todos.join('\n')}` };
  },
};

