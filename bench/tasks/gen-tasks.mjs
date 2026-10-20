// Генератор набора из 100 задач на вызов инструментов. Запуск: node bench/tasks/gen-tasks.mjs
// Оценивается первый вызов инструмента: имя и ключевые аргументы. Набор детерминирован.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tasks = [];
const counters = {};
const add = (category, history, expect) => {
  counters[category] = (counters[category] ?? 0) + 1;
  tasks.push({ id: `${category}-${String(counters[category]).padStart(2, '0')}`, category, messages: history, expect });
};
const user = (content) => ({ role: 'user', content });
const call = (id, name, args) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const result = (id, content) => ({ role: 'tool', tool_call_id: id, content });
const eq = (v) => ({ eq: v });
const re = (v) => ({ regex: v });
const has = (v) => ({ contains: v });

// A. read_file
const readFiles = ['src/main.ts', 'package.json', 'README.md', 'src/utils/date.ts', 'tests/api.test.ts', 'config/settings.yaml', 'src/server.py', 'Makefile', 'docs/setup.md', 'src/App.tsx', 'go.mod', 'Cargo.toml'];
const readTpl = [(f) => `Show me the contents of ${f}.`, (f) => `Открой файл ${f} и покажи, что внутри.`, (f) => `What's in ${f}?`, (f) => `Прочитай ${f}.`];
readFiles.forEach((f, i) => add('read', [user(readTpl[i % 4](f))], { tool: 'read_file', args: { path: eq(f) } }));

// B. list_dir
const dirs = ['.', 'src', 'src/components', 'tests', 'docs', 'config', 'scripts', 'packages/core'];
dirs.forEach((d, i) => {
  const q = d === '.' ? (i % 2 ? 'Покажи структуру проекта в корне.' : 'Show me the top-level layout of the project.') : i % 2 ? `Покажи список файлов в ${d}.` : `What files are in ${d}?`;
  add('list', [user(q)], { tool: 'list_dir', args: { path: d === '.' ? re('^(\\.|\\./|)$') : re(`^\\.?/?${d.replace(/[/.]/g, '\\$&')}/?$`) } });
});

// C. glob
const langs = [['TypeScript', 'ts'], ['Python', 'py'], ['Markdown', 'md'], ['JSON', 'json'], ['TSX', 'tsx'], ['CSS', 'css'], ['YAML', 'yaml'], ['Go', 'go'], ['Rust', 'rs'], ['shell', 'sh']];
langs.forEach(([l, ext], i) => add('glob', [user(i % 2 ? `Найди все файлы ${l} в проекте.` : `Find all ${l} files in the project.`)], { tool: 'glob', args: { pattern: re(`\\.${ext}\\b`) } }));

// D. grep
const symbols = ['handleRequest', 'parseConfig', 'TODO', 'formatDate', 'UserService', 'connectDb', 'retryCount', 'useAuth', 'renderChart', 'MAX_RETRIES', 'onError', 'loadPlugins'];
symbols.forEach((s, i) => add('grep', [user(i % 2 ? `Найди все упоминания ${s} в коде.` : `Where is ${s} used?`)], { tool: 'grep', args: { pattern: has(s) } }));

// E. shell
const shells = [
  ['Run the unit tests.', '(npm|pnpm|yarn|bun)\\s+(run\\s+)?test|pytest|vitest|jest'],
  ['Show the git status.', 'git\\s+status'],
  ['Install the project dependencies with npm.', 'npm\\s+(install|i|ci)\\b'],
  ['Create a directory named build_output.', 'mkdir\\s+(-p\\s+)?build_output'],
  ['Покажи последние 5 коммитов git.', 'git\\s+log.*(-5|-n\\s*5|--max-count=5)'],
  ['Собери проект командой npm run build.', 'npm\\s+run\\s+build'],
  ['Check the node version.', 'node\\s+(-v|--version)'],
  ['Run the linter.', 'lint'],
  ['Покажи текущую ветку git.', 'git\\s+(branch|rev-parse|status)'],
  ['Count the lines in src/main.ts.', 'wc\\s+-l.*src/main\\.ts'],
  ['Запусти python-скрипт scripts/seed.py.', 'python3?\\s+scripts/seed\\.py'],
  ['Show the diff of the staged changes.', 'git\\s+diff\\s+(--staged|--cached)'],
];
shells.forEach(([q, r]) => add('shell', [user(q)], { tool: 'shell', args: { command: re(r) } }));

// F. write_file
const writes = [
  ['.gitignore', 'Create a .gitignore that ignores node_modules and dist.', has('node_modules')],
  ['hello.py', 'Create hello.py that prints hello world.', has('print')],
  ['src/utils/sum.ts', 'Create src/utils/sum.ts exporting a function sum(a, b) that adds two numbers.', has('sum')],
  ['README.md', 'Создай README.md с заголовком "My Project".', has('My Project')],
  ['Dockerfile', 'Create a Dockerfile based on node:20.', re('FROM\\s+node')],
  ['config/settings.json', 'Create config/settings.json with {"debug": true}.', has('debug')],
  ['scripts/hello.sh', 'Создай скрипт scripts/hello.sh, который выводит hi через echo.', has('echo')],
  ['index.html', 'Create index.html with a heading "Welcome".', has('Welcome')],
  ['tests/sum.test.ts', 'Create tests/sum.test.ts with a test for the sum function.', has('sum')],
  ['.env.example', 'Create .env.example containing PORT=3000.', has('PORT=3000')],
];
writes.forEach(([p, q, c]) => add('write', [user(q)], { tool: 'write_file', args: { path: eq(p), content: c } }));

// G. edit_file
const edits = [
  ['src/main.ts', 'port = 3000', 'port = 8080'],
  ['package.json', '"version": "1.0.0"', '"version": "1.1.0"'],
  ['README.md', 'Colour', 'Color'],
  ['src/App.tsx', 'Hello', 'Welcome'],
  ['config/settings.yaml', 'debug: false', 'debug: true'],
  ['src/server.py', 'timeout=30', 'timeout=60'],
  ['Makefile', '-O0', '-O2'],
  ['src/utils/date.ts', 'getYear', 'getFullYear'],
  ['docs/setup.md', 'v1', 'v2'],
  ['go.mod', 'go 1.21', 'go 1.22'],
];
edits.forEach(([p, o, n], i) =>
  add('edit', [user(i % 2 ? `В файле ${p} замени \`${o}\` на \`${n}\`.` : `In ${p}, replace \`${o}\` with \`${n}\`.`)], {
    tool: 'edit_file',
    args: { path: eq(p), old_string: has(o), new_string: has(n) },
  }),
);

// H. без инструмента
['What does HTTP status 404 mean?', 'Что такое замыкание в JavaScript?', 'Say hello.', "Thanks, that's all for now.", 'Объясни разницу между let и const.', 'What is the capital of France?'].forEach((q) =>
  add('notool', [user(q)], { tool: null }),
);

// I. второй шаг цикла: решение зависит от результата предыдущего инструмента
const followGrep = [
  ['parseConfig', 'src/config/parse.ts:12:export function parseConfig(raw: string) {'],
  ['formatDate', 'src/utils/date.ts:5:export function formatDate(d: Date) {'],
  ['connectDb', 'src/db/connect.ts:3:export async function connectDb() {'],
  ['useAuth', 'src/hooks/useAuth.ts:8:export function useAuth() {'],
];
followGrep.forEach(([s, line]) =>
  add('step', [user(`Find where ${s} is defined and open that file.`), call('c1', 'grep', { pattern: s }), result('c1', line)], {
    tool: 'read_file',
    args: { path: eq(line.split(':')[0]) },
  }),
);
add('step', [user('Run the tests and fix the failure.'), call('c1', 'shell', { command: 'npm test' }), result('c1', 'FAIL tests/sum.test.ts\n  expected 3, received 4\n    at src/sum.ts:2')], { tool: 'read_file', args: { path: re('src/sum\\.ts|tests/sum\\.test\\.ts') } });
add('step', [user('Запусти тесты и разберись, что упало.'), call('c1', 'shell', { command: 'pytest' }), result('c1', 'FAILED tests/test_api.py::test_login - AssertionError: 401 != 200')], { tool: 'read_file', args: { path: re('test_api\\.py') } });
add('step', [user('Look at the docs folder and open the setup guide.'), call('c1', 'list_dir', { path: 'docs' }), result('c1', 'intro.md\nsetup.md\nfaq.md')], { tool: 'read_file', args: { path: re('docs/setup\\.md') } });
add('step', [user('Покажи файлы в src и открой точку входа.'), call('c1', 'list_dir', { path: 'src' }), result('c1', 'index.ts\nutils/\ncomponents/')], { tool: 'read_file', args: { path: re('index\\.ts') } });
add('step', [user('Change the port to 8080 in src/server.ts.'), call('c1', 'read_file', { path: 'src/server.ts' }), result('c1', "import http from 'node:http';\nconst port = 3000;\nhttp.createServer().listen(port);")], { tool: 'edit_file', args: { path: eq('src/server.ts'), old_string: has('3000'), new_string: has('8080') } });
add('step', [user('Bump the version in package.json to 0.2.0.'), call('c1', 'read_file', { path: 'package.json' }), result('c1', '{ "name": "demo", "version": "0.1.0" }')], { tool: 'edit_file', args: { path: eq('package.json'), new_string: has('0.2.0') } });
add('step', [user('Исправь опечатку Colour на Color в README.md.'), call('c1', 'read_file', { path: 'README.md' }), result('c1', '# Demo\nColour picker for the web.')], { tool: 'edit_file', args: { path: eq('README.md'), old_string: has('Colour'), new_string: has('Color') } });
add('step', [user('Create hello.py that prints hi and run it.'), call('c1', 'write_file', { path: 'hello.py', content: "print('hi')\n" }), result('c1', 'OK: wrote hello.py')], { tool: 'shell', args: { command: re('python3?\\s+hello\\.py') } });
add('step', [user('Write a test for sum in tests/sum.test.ts and run the tests.'), call('c1', 'write_file', { path: 'tests/sum.test.ts', content: "import { sum } from '../src/sum';\n" }), result('c1', 'OK: wrote tests/sum.test.ts')], { tool: 'shell', args: { command: re('test|vitest|jest') } });
add('step', [user('Install dependencies and start the dev server.'), call('c1', 'shell', { command: 'npm install' }), result('c1', 'added 120 packages in 8s')], { tool: 'shell', args: { command: re('npm\\s+(run\\s+)?dev|npm\\s+start') } });
add('step', [user('Is there a file named config.yaml? If so, show it.'), call('c1', 'glob', { pattern: '**/config.yaml' }), result('c1', 'config/config.yaml')], { tool: 'read_file', args: { path: re('config/config\\.yaml') } });
add('step', [user('Check whether the build passes and look at the error if not.'), call('c1', 'shell', { command: 'npm run build' }), result('c1', "error TS2304: Cannot find name 'foo'.\n  src/app.ts(10,5)")], { tool: 'read_file', args: { path: re('src/app\\.ts') } });

// J. скиллы
[
  ['Extract the text from report.pdf.', 'pdf-extract'],
  ['Write a commit message for my staged changes.', 'commit-message'],
  ['Сделай ревью моих изменений.', 'code-review'],
  ['Обнови CHANGELOG для релиза 1.2.', 'changelog'],
].forEach(([q, s]) => add('skill', [user(q)], { tool: 'skill', args: { name: eq(s) } }));

if (tasks.length !== 100) throw new Error(`ожидалось 100 задач, получилось ${tasks.length}`);
const out = join(dirname(fileURLToPath(import.meta.url)), 'tasks.json');
writeFileSync(out, `${JSON.stringify(tasks, null, 1)}\n`);
console.log(`записано ${tasks.length} задач в ${out}`);
console.log(counters);
