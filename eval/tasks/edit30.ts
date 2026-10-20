import { PKG, type EvalTask } from '../types.ts';

type T = Omit<EvalTask, 'suite'>;
const mk = (t: T): EvalTask => ({ suite: 'edit30', ...t });

/** Тест-файл в формате node:test. */
const test = (imports: string, body: string): string => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n${imports}\n\n${body}\n`;

export const EDIT30: EvalTask[] = [
  // ---------- исправление ошибок (тесты видны) ----------
  mk({
    id: 'fix-last-n', category: 'fix', showTests: true,
    prompt: 'The test in test/lastn.test.js fails. Fix the bug in src/lastn.js.',
    files: { ...PKG, 'src/lastn.js': `export function lastN(items, n) {\n  return items.slice(items.length - n - 1);\n}\n` },
    tests: { 'test/lastn.test.js': test("import { lastN } from '../src/lastn.js';", `test('lastN', () => {\n  assert.deepEqual(lastN([1, 2, 3, 4, 5], 2), [4, 5]);\n  assert.deepEqual(lastN([1, 2], 5), [1, 2]);\n  assert.deepEqual(lastN([1, 2, 3], 0), []);\n});`) },
    solution: { 'src/lastn.js': `export function lastN(items, n) {\n  if (n <= 0) return [];\n  return items.slice(Math.max(0, items.length - n));\n}\n` },
  }),
  mk({
    id: 'fix-average-empty', category: 'fix', showTests: true,
    prompt: 'average([]) returns NaN but should return 0. Fix it in src/stats.js, the tests are in test/stats.test.js.',
    files: { ...PKG, 'src/stats.js': `export function average(numbers) {\n  const sum = numbers.reduce((a, b) => a + b, 0);\n  return sum / numbers.length;\n}\n\nexport function max(numbers) {\n  return Math.max(...numbers);\n}\n` },
    tests: { 'test/stats.test.js': test("import { average, max } from '../src/stats.js';", `test('average', () => {\n  assert.equal(average([2, 4, 6]), 4);\n  assert.equal(average([]), 0);\n});\ntest('max', () => assert.equal(max([1, 9, 3]), 9));`) },
    solution: { 'src/stats.js': `export function average(numbers) {\n  if (numbers.length === 0) return 0;\n  const sum = numbers.reduce((a, b) => a + b, 0);\n  return sum / numbers.length;\n}\n\nexport function max(numbers) {\n  return Math.max(...numbers);\n}\n` },
  }),
  mk({
    id: 'fix-numeric-sort', category: 'fix', showTests: true,
    prompt: 'sortByAge in src/people.js sorts wrong when ages have different digit counts. Fix it so test/people.test.js passes.',
    files: { ...PKG, 'src/people.js': `export function sortByAge(people) {\n  return [...people].sort((a, b) => String(a.age).localeCompare(String(b.age)));\n}\n` },
    tests: { 'test/people.test.js': test("import { sortByAge } from '../src/people.js';", `test('sortByAge', () => {\n  const r = sortByAge([{ n: 'a', age: 100 }, { n: 'b', age: 9 }, { n: 'c', age: 25 }]);\n  assert.deepEqual(r.map((p) => p.n), ['b', 'c', 'a']);\n});`) },
    solution: { 'src/people.js': `export function sortByAge(people) {\n  return [...people].sort((a, b) => a.age - b.age);\n}\n` },
  }),
  mk({
    id: 'fix-missing-return', category: 'fix', showTests: true,
    prompt: 'Тест test/total.test.js падает: функция cartTotal в src/total.js возвращает undefined. Исправь её.',
    files: { ...PKG, 'src/total.js': `export function cartTotal(items) {\n  let total = 0;\n  for (const item of items) {\n    total += item.price * item.qty;\n  }\n}\n` },
    tests: { 'test/total.test.js': test("import { cartTotal } from '../src/total.js';", `test('cartTotal', () => {\n  assert.equal(cartTotal([{ price: 2, qty: 3 }, { price: 1.5, qty: 2 }]), 9);\n  assert.equal(cartTotal([]), 0);\n});`) },
    solution: { 'src/total.js': `export function cartTotal(items) {\n  let total = 0;\n  for (const item of items) {\n    total += item.price * item.qty;\n  }\n  return total;\n}\n` },
  }),
  mk({
    id: 'fix-case-insensitive', category: 'fix', showTests: true,
    prompt: 'findByName should ignore letter case. Fix src/users.js so the tests in test/users.test.js pass.',
    files: { ...PKG, 'src/users.js': `export function findByName(users, name) {\n  return users.find((u) => u.name === name);\n}\n` },
    tests: { 'test/users.test.js': test("import { findByName } from '../src/users.js';", `const users = [{ name: 'Alice' }, { name: 'Bob' }];\ntest('findByName', () => {\n  assert.equal(findByName(users, 'alice')?.name, 'Alice');\n  assert.equal(findByName(users, 'BOB')?.name, 'Bob');\n  assert.equal(findByName(users, 'carol'), undefined);\n});`) },
    solution: { 'src/users.js': `export function findByName(users, name) {\n  const needle = name.toLowerCase();\n  return users.find((u) => u.name.toLowerCase() === needle);\n}\n` },
  }),
  mk({
    id: 'fix-mutation', category: 'fix', showTests: true,
    prompt: 'addItem in src/list.js changes the array it receives, but it must return a new array and leave the input untouched. Fix it; tests are in test/list.test.js.',
    files: { ...PKG, 'src/list.js': `export function addItem(list, item) {\n  list.push(item);\n  return list;\n}\n` },
    tests: { 'test/list.test.js': test("import { addItem } from '../src/list.js';", `test('addItem is pure', () => {\n  const a = [1, 2];\n  const b = addItem(a, 3);\n  assert.deepEqual(b, [1, 2, 3]);\n  assert.deepEqual(a, [1, 2]);\n  assert.notEqual(a, b);\n});`) },
    solution: { 'src/list.js': `export function addItem(list, item) {\n  return [...list, item];\n}\n` },
  }),
  mk({
    id: 'fix-email-regex', category: 'fix', showTests: true,
    prompt: 'Valid emails with a plus sign (like a+b@example.com) are rejected by isEmail in src/validate.js. Fix it, tests: test/validate.test.js.',
    files: { ...PKG, 'src/validate.js': `export function isEmail(s) {\n  return /^[\\w.]+@[\\w-]+\\.[a-z]{2,}$/i.test(s);\n}\n` },
    tests: { 'test/validate.test.js': test("import { isEmail } from '../src/validate.js';", `test('isEmail', () => {\n  assert.ok(isEmail('a@example.com'));\n  assert.ok(isEmail('a+b@example.com'));\n  assert.ok(isEmail('first.last@mail.example.org'.replace('mail.', '')));\n  assert.ok(!isEmail('no-at-sign.com'));\n  assert.ok(!isEmail('a@b'));\n});`) },
    solution: { 'src/validate.js': `export function isEmail(s) {\n  return /^[\\w.+-]+@[\\w-]+\\.[a-z]{2,}$/i.test(s);\n}\n` },
  }),
  mk({
    id: 'fix-null-address', category: 'fix', showTests: true,
    prompt: 'getCity throws when the user has no address. It should return undefined instead. Fix src/user.js; tests in test/user.test.js.',
    files: { ...PKG, 'src/user.js': `export function getCity(user) {\n  return user.address.city;\n}\n` },
    tests: { 'test/user.test.js': test("import { getCity } from '../src/user.js';", `test('getCity', () => {\n  assert.equal(getCity({ address: { city: 'Oslo' } }), 'Oslo');\n  assert.equal(getCity({}), undefined);\n  assert.equal(getCity({ address: null }), undefined);\n});`) },
    solution: { 'src/user.js': `export function getCity(user) {\n  return user.address?.city;\n}\n` },
  }),

  // ---------- правки и новые возможности (скрытые тесты) ----------
  mk({
    id: 'rename-function', category: 'edit',
    prompt: 'Rename the function getUser to fetchUser everywhere in the project (definition and all usages).',
    files: { ...PKG, 'src/users.js': `export function getUser(id) {\n  return { id, name: 'user' + id };\n}\n`, 'src/profile.js': `import { getUser } from './users.js';\n\nexport function profileTitle(id) {\n  return 'Profile of ' + getUser(id).name;\n}\n`, 'src/index.js': `import { getUser } from './users.js';\nimport { profileTitle } from './profile.js';\n\nexport { getUser, profileTitle };\n` },
    tests: { 'test/rename.test.js': test("import * as api from '../src/index.js';\nimport * as users from '../src/users.js';", `test('renamed', () => {\n  assert.equal(typeof users.fetchUser, 'function');\n  assert.equal(users.getUser, undefined);\n  assert.equal(typeof api.fetchUser, 'function');\n  assert.equal(api.getUser, undefined);\n  assert.equal(api.profileTitle(3), 'Profile of user3');\n});`) },
    solution: { 'src/users.js': `export function fetchUser(id) {\n  return { id, name: 'user' + id };\n}\n`, 'src/profile.js': `import { fetchUser } from './users.js';\n\nexport function profileTitle(id) {\n  return 'Profile of ' + fetchUser(id).name;\n}\n`, 'src/index.js': `import { fetchUser } from './users.js';\nimport { profileTitle } from './profile.js';\n\nexport { fetchUser, profileTitle };\n` },
  }),
  mk({
    id: 'add-param-separator', category: 'edit',
    prompt: 'Add an optional second parameter "separator" (default ", ") to joinNames in src/names.js and use it instead of the hard-coded separator.',
    files: { ...PKG, 'src/names.js': `export function joinNames(names) {\n  return names.join(', ');\n}\n` },
    tests: { 'test/names.test.js': test("import { joinNames } from '../src/names.js';", `test('joinNames', () => {\n  assert.equal(joinNames(['a', 'b']), 'a, b');\n  assert.equal(joinNames(['a', 'b', 'c'], ' | '), 'a | b | c');\n  assert.equal(joinNames([], '-'), '');\n});`) },
    solution: { 'src/names.js': `export function joinNames(names, separator = ', ') {\n  return names.join(separator);\n}\n` },
  }),
  mk({
    id: 'add-capitalize', category: 'feature',
    prompt: 'Add and export a function capitalize(str) to src/strings.js that uppercases the first letter and lowercases the rest. Empty string returns empty string.',
    files: { ...PKG, 'src/strings.js': `export function trimAll(s) {\n  return s.replace(/\\s+/g, ' ').trim();\n}\n` },
    tests: { 'test/strings.test.js': test("import { capitalize, trimAll } from '../src/strings.js';", `test('capitalize', () => {\n  assert.equal(capitalize('hELLO'), 'Hello');\n  assert.equal(capitalize('a'), 'A');\n  assert.equal(capitalize(''), '');\n});\ntest('trimAll still works', () => assert.equal(trimAll('  a   b '), 'a b'));`) },
    solution: { 'src/strings.js': `export function trimAll(s) {\n  return s.replace(/\\s+/g, ' ').trim();\n}\n\nexport function capitalize(str) {\n  if (!str) return '';\n  return str[0].toUpperCase() + str.slice(1).toLowerCase();\n}\n` },
  }),
  mk({
    id: 'change-timeout', category: 'edit',
    prompt: 'Измени таймаут по умолчанию в src/config.js с 30 на 60 секунд. Остальные настройки не трогай.',
    files: { ...PKG, 'src/config.js': `export const config = {\n  retries: 3,\n  timeoutSeconds: 30,\n  baseUrl: 'https://api.example.com',\n};\n` },
    tests: { 'test/config.test.js': test("import { config } from '../src/config.js';", `test('config', () => {\n  assert.equal(config.timeoutSeconds, 60);\n  assert.equal(config.retries, 3);\n  assert.equal(config.baseUrl, 'https://api.example.com');\n});`) },
    solution: { 'src/config.js': `export const config = {\n  retries: 3,\n  timeoutSeconds: 60,\n  baseUrl: 'https://api.example.com',\n};\n` },
  }),
  mk({
    id: 'add-export-barrel', category: 'edit',
    prompt: 'The function slugify exists in src/slug.js but cannot be used from src/index.js. Export it there (together with the existing exports).',
    files: { ...PKG, 'src/slug.js': `export function slugify(s) {\n  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n}\n`, 'src/math.js': `export const double = (n) => n * 2;\n`, 'src/index.js': `export { double } from './math.js';\n` },
    tests: { 'test/index.test.js': test("import { double, slugify } from '../src/index.js';", `test('barrel', () => {\n  assert.equal(double(4), 8);\n  assert.equal(slugify('Hello, World!'), 'hello-world');\n});`) },
    solution: { 'src/index.js': `export { double } from './math.js';\nexport { slugify } from './slug.js';\n` },
  }),
  mk({
    id: 'add-validation', category: 'feature',
    prompt: 'createUser(name, age) in src/create-user.js must throw an Error with the message "invalid age" when age is negative or not a number. Keep the normal behaviour.',
    files: { ...PKG, 'src/create-user.js': `export function createUser(name, age) {\n  return { name, age, createdAt: 0 };\n}\n` },
    tests: { 'test/create-user.test.js': test("import { createUser } from '../src/create-user.js';", `test('createUser', () => {\n  assert.deepEqual(createUser('Ann', 30), { name: 'Ann', age: 30, createdAt: 0 });\n  assert.throws(() => createUser('Bob', -1), { message: 'invalid age' });\n  assert.throws(() => createUser('Bob', 'x'), { message: 'invalid age' });\n  assert.equal(createUser('Zero', 0).age, 0);\n});`) },
    solution: { 'src/create-user.js': `export function createUser(name, age) {\n  if (typeof age !== 'number' || Number.isNaN(age) || age < 0) throw new Error('invalid age');\n  return { name, age, createdAt: 0 };\n}\n` },
  }),
  mk({
    id: 'default-arg', category: 'edit',
    prompt: 'Make greet() work without arguments: the name should default to "world" (so greet() returns "Hello, world!").',
    files: { ...PKG, 'src/greet.js': `export function greet(name) {\n  return 'Hello, ' + name + '!';\n}\n` },
    tests: { 'test/greet.test.js': test("import { greet } from '../src/greet.js';", `test('greet', () => {\n  assert.equal(greet(), 'Hello, world!');\n  assert.equal(greet('Ann'), 'Hello, Ann!');\n});`) },
    solution: { 'src/greet.js': `export function greet(name = 'world') {\n  return 'Hello, ' + name + '!';\n}\n` },
  }),
  mk({
    id: 'update-package-json', category: 'edit',
    prompt: 'In package.json bump the version to 1.3.0 and add a script "lint" with the value "echo lint". Keep everything else.',
    files: { 'package.json': '{\n  "name": "task",\n  "version": "1.2.3",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n' },
    tests: { 'test/pkg.test.js': test("import { readFileSync } from 'node:fs';", `test('package.json', () => {\n  const p = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));\n  assert.equal(p.version, '1.3.0');\n  assert.equal(p.scripts.lint, 'echo lint');\n  assert.equal(p.scripts.test, 'node --test');\n  assert.equal(p.type, 'module');\n  assert.equal(p.name, 'task');\n});`) },
    solution: { 'package.json': '{\n  "name": "task",\n  "version": "1.3.0",\n  "type": "module",\n  "scripts": { "test": "node --test", "lint": "echo lint" }\n}\n' },
  }),
  mk({
    id: 'add-stack-peek', category: 'feature',
    prompt: 'Add a method peek() to the Stack class in src/stack.js: it returns the top element without removing it, or undefined when the stack is empty.',
    files: { ...PKG, 'src/stack.js': `export class Stack {\n  #items = [];\n\n  push(x) {\n    this.#items.push(x);\n  }\n\n  pop() {\n    return this.#items.pop();\n  }\n\n  get size() {\n    return this.#items.length;\n  }\n}\n` },
    tests: { 'test/stack.test.js': test("import { Stack } from '../src/stack.js';", `test('peek', () => {\n  const s = new Stack();\n  assert.equal(s.peek(), undefined);\n  s.push(1);\n  s.push(2);\n  assert.equal(s.peek(), 2);\n  assert.equal(s.size, 2);\n  assert.equal(s.pop(), 2);\n  assert.equal(s.peek(), 1);\n});`) },
    solution: { 'src/stack.js': `export class Stack {\n  #items = [];\n\n  push(x) {\n    this.#items.push(x);\n  }\n\n  pop() {\n    return this.#items.pop();\n  }\n\n  peek() {\n    return this.#items[this.#items.length - 1];\n  }\n\n  get size() {\n    return this.#items.length;\n  }\n}\n` },
  }),
  mk({
    id: 'callback-to-promise', category: 'refactor',
    prompt: 'Convert readConfig in src/config-reader.js from callback style to returning a Promise (no callback parameter anymore). Resolve with the parsed object, reject on invalid JSON.',
    files: { ...PKG, 'src/config-reader.js': `export function readConfig(text, callback) {\n  try {\n    callback(null, JSON.parse(text));\n  } catch (e) {\n    callback(e);\n  }\n}\n` },
    tests: { 'test/config-reader.test.js': test("import { readConfig } from '../src/config-reader.js';", `test('readConfig', async () => {\n  assert.deepEqual(await readConfig('{"a":1}'), { a: 1 });\n  await assert.rejects(() => readConfig('{bad'), SyntaxError);\n});`) },
    solution: { 'src/config-reader.js': `export function readConfig(text) {\n  return new Promise((resolve, reject) => {\n    try {\n      resolve(JSON.parse(text));\n    } catch (e) {\n      reject(e);\n    }\n  });\n}\n` },
  }),
  mk({
    id: 'add-fullname-getter', category: 'feature',
    prompt: 'Add a getter fullName to the Person class in src/person.js that returns "first last".',
    files: { ...PKG, 'src/person.js': `export class Person {\n  constructor(first, last) {\n    this.first = first;\n    this.last = last;\n  }\n}\n` },
    tests: { 'test/person.test.js': test("import { Person } from '../src/person.js';", `test('fullName', () => {\n  const p = new Person('Ada', 'Lovelace');\n  assert.equal(p.fullName, 'Ada Lovelace');\n  p.first = 'Augusta';\n  assert.equal(p.fullName, 'Augusta Lovelace');\n});`) },
    solution: { 'src/person.js': `export class Person {\n  constructor(first, last) {\n    this.first = first;\n    this.last = last;\n  }\n\n  get fullName() {\n    return this.first + ' ' + this.last;\n  }\n}\n` },
  }),
  mk({
    id: 'add-reducer-case', category: 'feature',
    prompt: 'Add a "pause" action to the reducer in src/player.js: it sets status to "paused" only when the current status is "playing", otherwise leaves the state unchanged.',
    files: { ...PKG, 'src/player.js': `export function reducer(state, action) {\n  switch (action.type) {\n    case 'play':\n      return { ...state, status: 'playing' };\n    case 'stop':\n      return { ...state, status: 'stopped' };\n    default:\n      return state;\n  }\n}\n` },
    tests: { 'test/player.test.js': test("import { reducer } from '../src/player.js';", `test('pause', () => {\n  assert.deepEqual(reducer({ status: 'playing' }, { type: 'pause' }), { status: 'paused' });\n  const stopped = { status: 'stopped' };\n  assert.equal(reducer(stopped, { type: 'pause' }), stopped);\n  assert.deepEqual(reducer({ status: 'paused' }, { type: 'play' }), { status: 'playing' });\n});`) },
    solution: { 'src/player.js': `export function reducer(state, action) {\n  switch (action.type) {\n    case 'play':\n      return { ...state, status: 'playing' };\n    case 'pause':\n      return state.status === 'playing' ? { ...state, status: 'paused' } : state;\n    case 'stop':\n      return { ...state, status: 'stopped' };\n    default:\n      return state;\n  }\n}\n` },
  }),

  // ---------- рефакторинг и конфигурация ----------
  mk({
    id: 'extract-format-money', category: 'refactor',
    prompt: 'The money formatting is duplicated in src/invoice.js. Extract it into an exported function formatMoney(amount) in the same file (format: "$12.50") and use it in both places.',
    files: { ...PKG, 'src/invoice.js': `export function lineText(item) {\n  return item.name + ': $' + item.price.toFixed(2);\n}\n\nexport function totalText(items) {\n  const total = items.reduce((s, i) => s + i.price, 0);\n  return 'Total: $' + total.toFixed(2);\n}\n` },
    tests: { 'test/invoice.test.js': test("import { formatMoney, lineText, totalText } from '../src/invoice.js';\nimport { readFileSync } from 'node:fs';", `test('formatMoney', () => {\n  assert.equal(formatMoney(12.5), '$12.50');\n  assert.equal(formatMoney(3), '$3.00');\n});\ntest('uses formatMoney', () => {\n  assert.equal(lineText({ name: 'Pen', price: 1.2 }), 'Pen: $1.20');\n  assert.equal(totalText([{ price: 1 }, { price: 2.5 }]), 'Total: $3.50');\n  const src = readFileSync(new URL('../src/invoice.js', import.meta.url), 'utf8');\n  assert.equal(src.split('toFixed(2)').length - 1, 1);\n});`) },
    solution: { 'src/invoice.js': `export function formatMoney(amount) {\n  return '$' + amount.toFixed(2);\n}\n\nexport function lineText(item) {\n  return item.name + ': ' + formatMoney(item.price);\n}\n\nexport function totalText(items) {\n  const total = items.reduce((s, i) => s + i.price, 0);\n  return 'Total: ' + formatMoney(total);\n}\n` },
  }),
  mk({
    id: 'cjs-to-esm', category: 'refactor',
    prompt: 'src/legacy.js uses CommonJS (require / module.exports) but the project is an ES module project. Convert it to ES modules, keeping the same exports.',
    files: { ...PKG, 'src/legacy.js': `const path = require('node:path');\n\nfunction extOf(file) {\n  return path.extname(file).slice(1);\n}\n\nfunction baseOf(file) {\n  return path.basename(file, path.extname(file));\n}\n\nmodule.exports = { extOf, baseOf };\n` },
    tests: { 'test/legacy.test.js': test("import { extOf, baseOf } from '../src/legacy.js';", `test('legacy', () => {\n  assert.equal(extOf('a/b/file.txt'), 'txt');\n  assert.equal(baseOf('a/b/file.txt'), 'file');\n});`) },
    solution: { 'src/legacy.js': `import path from 'node:path';\n\nexport function extOf(file) {\n  return path.extname(file).slice(1);\n}\n\nexport function baseOf(file) {\n  return path.basename(file, path.extname(file));\n}\n` },
  }),
  mk({
    id: 'split-csv-module', category: 'refactor',
    prompt: 'Move parseCsvLine out of src/utils.js into a new file src/csv.js (exported there). src/utils.js must keep working and still export sum.',
    files: { ...PKG, 'src/utils.js': `export function sum(a) {\n  return a.reduce((x, y) => x + y, 0);\n}\n\nexport function parseCsvLine(line) {\n  return line.split(',').map((s) => s.trim());\n}\n` },
    tests: { 'test/csv.test.js': test("import { parseCsvLine } from '../src/csv.js';\nimport * as utils from '../src/utils.js';", `test('csv moved', () => {\n  assert.deepEqual(parseCsvLine('a, b,c'), ['a', 'b', 'c']);\n  assert.equal(utils.sum([1, 2, 3]), 6);\n  assert.equal(utils.parseCsvLine, undefined);\n});`) },
    solution: { 'src/utils.js': `export function sum(a) {\n  return a.reduce((x, y) => x + y, 0);\n}\n`, 'src/csv.js': `export function parseCsvLine(line) {\n  return line.split(',').map((s) => s.trim());\n}\n` },
  }),
  mk({
    id: 'remove-debug-logs', category: 'refactor',
    prompt: 'Remove all console.log debugging statements from src/calc.js. The functions must keep returning the same values.',
    files: { ...PKG, 'src/calc.js': `export function add(a, b) {\n  console.log('add called', a, b);\n  return a + b;\n}\n\nexport function mul(a, b) {\n  console.log('mul called');\n  const r = a * b;\n  console.log('result', r);\n  return r;\n}\n` },
    tests: { 'test/calc.test.js': test("import { add, mul } from '../src/calc.js';", `test('no logging', () => {\n  const calls = [];\n  const orig = console.log;\n  console.log = (...a) => calls.push(a);\n  try {\n    assert.equal(add(2, 3), 5);\n    assert.equal(mul(2, 3), 6);\n  } finally {\n    console.log = orig;\n  }\n  assert.equal(calls.length, 0);\n});`) },
    solution: { 'src/calc.js': `export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n` },
  }),
  mk({
    id: 'fix-moved-imports', category: 'fix',
    prompt: 'The file helpers.js was moved to src/lib/helpers.js, and now the imports in src/a.js and src/b.js are broken. Fix the import paths.',
    files: { ...PKG, 'src/lib/helpers.js': `export const twice = (n) => n * 2;\n`, 'src/a.js': `import { twice } from './helpers.js';\n\nexport const a = (n) => twice(n) + 1;\n`, 'src/b.js': `import { twice } from '../helpers.js';\n\nexport const b = (n) => twice(n) - 1;\n` },
    tests: { 'test/ab.test.js': test("import { a } from '../src/a.js';\nimport { b } from '../src/b.js';", `test('imports', () => {\n  assert.equal(a(5), 11);\n  assert.equal(b(5), 9);\n});`) },
    solution: { 'src/a.js': `import { twice } from './lib/helpers.js';\n\nexport const a = (n) => twice(n) + 1;\n`, 'src/b.js': `import { twice } from './lib/helpers.js';\n\nexport const b = (n) => twice(n) - 1;\n` },
  }),
  mk({
    id: 'fix-import-extension', category: 'fix',
    prompt: 'Running the tests fails with ERR_MODULE_NOT_FOUND from src/main.js. It is an ES module project, fix the import.',
    files: { ...PKG, 'src/util.js': `export const label = (s) => '[' + s + ']';\n`, 'src/main.js': `import { label } from './util';\n\nexport const title = (s) => label(s.toUpperCase());\n` },
    tests: { 'test/main.test.js': test("import { title } from '../src/main.js';", `test('title', () => assert.equal(title('hi'), '[HI]'));`) },
    solution: { 'src/main.js': `import { label } from './util.js';\n\nexport const title = (s) => label(s.toUpperCase());\n` },
  }),
  mk({
    id: 'fix-syntax-error', category: 'fix', showTests: true,
    prompt: 'src/parse.js has a syntax error and the tests cannot even load it. Find and fix it.',
    files: { ...PKG, 'src/parse.js': `export function parseKeyValue(line) {\n  const idx = line.indexOf('=');\n  if (idx < 0) {\n    return null;\n  \n  return { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };\n}\n` },
    tests: { 'test/parse.test.js': test("import { parseKeyValue } from '../src/parse.js';", `test('parseKeyValue', () => {\n  assert.deepEqual(parseKeyValue('a = 1'), { key: 'a', value: '1' });\n  assert.equal(parseKeyValue('nope'), null);\n});`) },
    solution: { 'src/parse.js': `export function parseKeyValue(line) {\n  const idx = line.indexOf('=');\n  if (idx < 0) {\n    return null;\n  }\n  return { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };\n}\n` },
  }),
  mk({
    id: 'implement-todo', category: 'feature',
    prompt: 'Implement the function marked TODO in src/words.js according to its comment.',
    files: { ...PKG, 'src/words.js': `/**\n * Returns the longest word in the sentence (words are separated by spaces).\n * If several words share the maximum length, return the first one.\n * An empty sentence returns an empty string.\n */\nexport function longestWord(sentence) {\n  // TODO: implement\n  throw new Error('not implemented');\n}\n\nexport function wordCount(sentence) {\n  return sentence.split(' ').filter(Boolean).length;\n}\n` },
    tests: { 'test/words.test.js': test("import { longestWord, wordCount } from '../src/words.js';", `test('longestWord', () => {\n  assert.equal(longestWord('a quick brown fox'), 'quick');\n  assert.equal(longestWord('one two six'), 'one');\n  assert.equal(longestWord(''), '');\n  assert.equal(wordCount('a b c'), 3);\n});`) },
    solution: { 'src/words.js': `/**\n * Returns the longest word in the sentence (words are separated by spaces).\n * If several words share the maximum length, return the first one.\n * An empty sentence returns an empty string.\n */\nexport function longestWord(sentence) {\n  let best = '';\n  for (const w of sentence.split(' ')) {\n    if (w.length > best.length) best = w;\n  }\n  return best;\n}\n\nexport function wordCount(sentence) {\n  return sentence.split(' ').filter(Boolean).length;\n}\n` },
  }),
  mk({
    id: 'add-clamp-option', category: 'edit',
    prompt: 'Добавь в функцию paginate (src/paginate.js) защиту: номер страницы меньше 1 должен считаться первой страницей, а больше последней — последней.',
    files: { ...PKG, 'src/paginate.js': `export function paginate(items, page, perPage) {\n  const start = (page - 1) * perPage;\n  return items.slice(start, start + perPage);\n}\n` },
    tests: { 'test/paginate.test.js': test("import { paginate } from '../src/paginate.js';", `const items = [1, 2, 3, 4, 5];\ntest('paginate', () => {\n  assert.deepEqual(paginate(items, 1, 2), [1, 2]);\n  assert.deepEqual(paginate(items, 3, 2), [5]);\n  assert.deepEqual(paginate(items, 0, 2), [1, 2]);\n  assert.deepEqual(paginate(items, -4, 2), [1, 2]);\n  assert.deepEqual(paginate(items, 99, 2), [5]);\n  assert.deepEqual(paginate([], 3, 2), []);\n});`) },
    solution: { 'src/paginate.js': `export function paginate(items, page, perPage) {\n  const last = Math.max(1, Math.ceil(items.length / perPage));\n  const p = Math.min(Math.max(page, 1), last);\n  const start = (p - 1) * perPage;\n  return items.slice(start, start + perPage);\n}\n` },
  }),
  mk({
    id: 'fix-async-await', category: 'fix', showTests: true,
    prompt: 'loadAll in src/loader.js returns an array of pending promises instead of the loaded values. Fix it.',
    files: { ...PKG, 'src/loader.js': `async function load(id) {\n  return { id, ok: true };\n}\n\nexport async function loadAll(ids) {\n  return ids.map(async (id) => load(id));\n}\n` },
    tests: { 'test/loader.test.js': test("import { loadAll } from '../src/loader.js';", `test('loadAll', async () => {\n  assert.deepEqual(await loadAll([1, 2]), [{ id: 1, ok: true }, { id: 2, ok: true }]);\n});`) },
    solution: { 'src/loader.js': `async function load(id) {\n  return { id, ok: true };\n}\n\nexport async function loadAll(ids) {\n  return Promise.all(ids.map((id) => load(id)));\n}\n` },
  }),
];
