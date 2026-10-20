/** Набор инструментов агента (v0): короткие описания, потому что на 8 ГБ контекст дорог. */

const fn = (name, description, properties, required) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
const str = (description) => ({ type: 'string', description });

export const TOOLS = [
  fn('read_file', 'Read a text file.', { path: str('Path relative to the project root') }, ['path']),
  fn('write_file', 'Create or overwrite a file.', { path: str('File path'), content: str('Full file content') }, ['path', 'content']),
  fn(
    'edit_file',
    'Replace one exact string in a file.',
    { path: str('File path'), old_string: str('Exact text to replace'), new_string: str('Replacement text') },
    ['path', 'old_string', 'new_string'],
  ),
  fn('list_dir', 'List files in a directory.', { path: str('Directory path, "." for the root') }, ['path']),
  fn('glob', 'Find files by glob pattern.', { pattern: str('Glob pattern such as **/*.ts') }, ['pattern']),
  fn('grep', 'Search file contents with a regex.', { pattern: str('Regex to search for'), path: str('Directory or file, optional') }, ['pattern']),
  fn('shell', 'Run a shell command in the project root.', { command: str('Command line') }, ['command']),
  fn('skill', 'Load the instructions of an installed skill by name.', { name: str('Skill name') }, ['name']),
];

export const SYSTEM_PROMPT =
  'You are a coding agent working in a project directory. Use the tools to act on the project. ' +
  'Paths are relative to the project root. Call exactly one tool when an action is needed; answer directly when no tool is needed.';

/** Для режима «схема»: инструменты описываются в промпте, а ответ ограничивается JSON-схемой. */
export function schemaModeSetup(tools) {
  const variants = tools.map((t) => ({
    type: 'object',
    properties: { tool: { const: t.function.name }, arguments: t.function.parameters },
    required: ['tool', 'arguments'],
    additionalProperties: false,
  }));
  variants.push({
    type: 'object',
    properties: { tool: { const: 'reply' }, arguments: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
    required: ['tool', 'arguments'],
    additionalProperties: false,
  });
  const listing = tools.map((t) => `- ${t.function.name}: ${t.function.description} Arguments: ${JSON.stringify(t.function.parameters.properties)}`).join('\n');
  return {
    schema: { anyOf: variants },
    system:
      `${SYSTEM_PROMPT}\nRespond with a single JSON object {"tool": <name>, "arguments": {...}}. Available tools:\n${listing}\n- reply: answer the user directly. Arguments: {"text": string}`,
  };
}
