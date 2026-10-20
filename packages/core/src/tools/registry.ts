import type { ToolDefinition } from '../inference/backend.ts';
import { editFile, globTool, grep, listDir, readFile, writeFile } from './fs-tools.ts';
import { hostApp } from './host-app.ts';
import { skillTool, todoTool } from './meta-tools.ts';
import { shell } from './shell.ts';
import type { Tool } from './types.ts';

/** Набор инструментов в промпте: чем меньше, тем надёжнее вызовы и дешевле контекст (см. план). */
export type Toolset = 'read' | 'edit' | 'full';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<any>>();

  register(tool: Tool<any>): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool<any> | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as unknown as Record<string, unknown> }));
  }
}

const TOOLSETS: Record<Toolset, Tool<any>[]> = {
  read: [readFile, listDir, globTool, grep],
  edit: [readFile, listDir, globTool, grep, writeFile, editFile, shell, skillTool],
  full: [readFile, listDir, globTool, grep, writeFile, editFile, shell, skillTool, todoTool, hostApp],
};

export function createRegistry(toolset: Toolset = 'edit', opts: { skills?: boolean } = {}): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of TOOLSETS[toolset]) {
    if (t.name === 'skill' && opts.skills === false) continue;
    reg.register(t);
  }
  return reg;
}
