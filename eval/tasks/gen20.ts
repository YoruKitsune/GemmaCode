import { PKG, type EvalTask } from '../types.ts';

type T = Omit<EvalTask, 'suite' | 'category'>;
const mk = (t: T): EvalTask => ({ suite: 'gen20', category: 'gen', ...t });
const test = (imports: string, body: string): string => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n${imports}\n\n${body}\n`;

/** Генерация нового кода по описанию: файл создаёт агент, проверяют скрытые тесты. */
export const GEN20: EvalTask[] = [
  mk({
    id: 'gen-slugify',
    prompt: 'Create src/slugify.js exporting a function slugify(text): lowercase, replace every run of non-alphanumeric characters with a single "-", and strip leading and trailing dashes.',
    files: { ...PKG },
    tests: { 'test/slugify.test.js': test("import { slugify } from '../src/slugify.js';", `test('slugify', () => {\n  assert.equal(slugify('Hello, World!'), 'hello-world');\n  assert.equal(slugify('  Many   spaces  '), 'many-spaces');\n  assert.equal(slugify('--a--b--'), 'a-b');\n  assert.equal(slugify('Already-slug'), 'already-slug');\n  assert.equal(slugify('!!!'), '');\n});`) },
    solution: { 'src/slugify.js': `export function slugify(text) {\n  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n}\n` },
  }),
  mk({
    id: 'gen-palindrome',
    prompt: 'Создай файл src/palindrome.js с экспортируемой функцией isPalindrome(text): true, если строка читается одинаково в обе стороны, игнорируя регистр, пробелы и знаки препинания.',
    files: { ...PKG },
    tests: { 'test/palindrome.test.js': test("import { isPalindrome } from '../src/palindrome.js';", `test('isPalindrome', () => {\n  assert.equal(isPalindrome('A man, a plan, a canal: Panama'), true);\n  assert.equal(isPalindrome('racecar'), true);\n  assert.equal(isPalindrome('hello'), false);\n  assert.equal(isPalindrome(''), true);\n  assert.equal(isPalindrome('No lemon, no melon'), true);\n});`) },
    solution: { 'src/palindrome.js': `export function isPalindrome(text) {\n  const s = text.toLowerCase().replace(/[^a-z0-9]/g, '');\n  return s === [...s].reverse().join('');\n}\n` },
  }),
  mk({
    id: 'gen-fizzbuzz',
    prompt: 'Create src/fizzbuzz.js exporting fizzbuzz(n) that returns an array of strings for 1..n: "Fizz" for multiples of 3, "Buzz" for multiples of 5, "FizzBuzz" for both, otherwise the number as a string.',
    files: { ...PKG },
    tests: { 'test/fizzbuzz.test.js': test("import { fizzbuzz } from '../src/fizzbuzz.js';", `test('fizzbuzz', () => {\n  assert.deepEqual(fizzbuzz(5), ['1', '2', 'Fizz', '4', 'Buzz']);\n  assert.equal(fizzbuzz(15)[14], 'FizzBuzz');\n  assert.deepEqual(fizzbuzz(0), []);\n  assert.equal(fizzbuzz(100).length, 100);\n});`) },
    solution: { 'src/fizzbuzz.js': `export function fizzbuzz(n) {\n  const out = [];\n  for (let i = 1; i <= n; i++) out.push(i % 15 === 0 ? 'FizzBuzz' : i % 3 === 0 ? 'Fizz' : i % 5 === 0 ? 'Buzz' : String(i));\n  return out;\n}\n` },
  }),
  mk({
    id: 'gen-chunk',
    prompt: 'Create src/chunk.js exporting chunk(items, size) that splits an array into arrays of at most `size` elements. size must be a positive integer, otherwise throw a RangeError.',
    files: { ...PKG },
    tests: { 'test/chunk.test.js': test("import { chunk } from '../src/chunk.js';", `test('chunk', () => {\n  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);\n  assert.deepEqual(chunk([], 3), []);\n  assert.deepEqual(chunk([1, 2], 5), [[1, 2]]);\n  assert.throws(() => chunk([1], 0), RangeError);\n  assert.throws(() => chunk([1], 1.5), RangeError);\n});`) },
    solution: { 'src/chunk.js': `export function chunk(items, size) {\n  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive integer');\n  const out = [];\n  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));\n  return out;\n}\n` },
  }),
  mk({
    id: 'gen-memoize',
    prompt: 'Create src/memoize.js exporting memoize(fn) that caches results of a function by its first argument (use a Map). The wrapped function must call fn only once per distinct argument.',
    files: { ...PKG },
    tests: { 'test/memoize.test.js': test("import { memoize } from '../src/memoize.js';", `test('memoize', () => {\n  let calls = 0;\n  const sq = memoize((x) => (calls++, x * x));\n  assert.equal(sq(4), 16);\n  assert.equal(sq(4), 16);\n  assert.equal(sq(5), 25);\n  assert.equal(calls, 2);\n  const undef = memoize(() => (calls++, undefined));\n  undef(1);\n  undef(1);\n  assert.equal(calls, 3);\n});`) },
    solution: { 'src/memoize.js': `export function memoize(fn) {\n  const cache = new Map();\n  return (arg) => {\n    if (!cache.has(arg)) cache.set(arg, fn(arg));\n    return cache.get(arg);\n  };\n}\n` },
  }),
  mk({
    id: 'gen-parse-query',
    prompt: 'Create src/query.js exporting parseQuery(qs) that parses a URL query string like "a=1&b=hello%20world" (with or without a leading "?") into an object with decoded keys and values. A key without "=" gets the value "". Repeated keys keep the last value.',
    files: { ...PKG },
    tests: { 'test/query.test.js': test("import { parseQuery } from '../src/query.js';", `test('parseQuery', () => {\n  assert.deepEqual(parseQuery('a=1&b=hello%20world'), { a: '1', b: 'hello world' });\n  assert.deepEqual(parseQuery('?x=1'), { x: '1' });\n  assert.deepEqual(parseQuery('flag&k=v'), { flag: '', k: 'v' });\n  assert.deepEqual(parseQuery('a=1&a=2'), { a: '2' });\n  assert.deepEqual(parseQuery(''), {});\n  assert.deepEqual(parseQuery('q=a%26b'), { q: 'a&b' });\n});`) },
    solution: { 'src/query.js': `export function parseQuery(qs) {\n  const out = {};\n  const s = qs.startsWith('?') ? qs.slice(1) : qs;\n  if (!s) return out;\n  for (const part of s.split('&')) {\n    if (!part) continue;\n    const i = part.indexOf('=');\n    const key = decodeURIComponent(i < 0 ? part : part.slice(0, i));\n    out[key] = i < 0 ? '' : decodeURIComponent(part.slice(i + 1));\n  }\n  return out;\n}\n` },
  }),
  mk({
    id: 'gen-lru-cache',
    prompt: 'Create src/lru.js exporting a class LRUCache. Constructor takes capacity. Methods: get(key) returns the value or undefined and marks the key as most recently used; set(key, value) inserts or updates and evicts the least recently used key when over capacity; property size.',
    files: { ...PKG },
    tests: { 'test/lru.test.js': test("import { LRUCache } from '../src/lru.js';", `test('LRUCache', () => {\n  const c = new LRUCache(2);\n  c.set('a', 1);\n  c.set('b', 2);\n  assert.equal(c.get('a'), 1);\n  c.set('c', 3);\n  assert.equal(c.get('b'), undefined);\n  assert.equal(c.get('a'), 1);\n  assert.equal(c.get('c'), 3);\n  assert.equal(c.size, 2);\n  c.set('a', 10);\n  c.set('d', 4);\n  assert.equal(c.get('c'), undefined);\n  assert.equal(c.get('a'), 10);\n});`) },
    solution: { 'src/lru.js': `export class LRUCache {\n  #map = new Map();\n  #capacity;\n\n  constructor(capacity) {\n    this.#capacity = capacity;\n  }\n\n  get size() {\n    return this.#map.size;\n  }\n\n  get(key) {\n    if (!this.#map.has(key)) return undefined;\n    const v = this.#map.get(key);\n    this.#map.delete(key);\n    this.#map.set(key, v);\n    return v;\n  }\n\n  set(key, value) {\n    this.#map.delete(key);\n    this.#map.set(key, value);\n    if (this.#map.size > this.#capacity) this.#map.delete(this.#map.keys().next().value);\n  }\n}\n` },
  }),
  mk({
    id: 'gen-event-emitter',
    prompt: 'Create src/emitter.js exporting a class Emitter with methods on(event, fn), off(event, fn), once(event, fn) and emit(event, ...args). emit calls the listeners in registration order and returns the number of listeners called.',
    files: { ...PKG },
    tests: { 'test/emitter.test.js': test("import { Emitter } from '../src/emitter.js';", `test('Emitter', () => {\n  const e = new Emitter();\n  const log = [];\n  const a = (x) => log.push('a' + x);\n  e.on('go', a);\n  e.on('go', (x) => log.push('b' + x));\n  e.once('go', (x) => log.push('c' + x));\n  assert.equal(e.emit('go', 1), 3);\n  assert.equal(e.emit('go', 2), 2);\n  assert.deepEqual(log, ['a1', 'b1', 'c1', 'a2', 'b2']);\n  e.off('go', a);\n  assert.equal(e.emit('go', 3), 1);\n  assert.equal(e.emit('none'), 0);\n});`) },
    solution: { 'src/emitter.js': `export class Emitter {\n  #listeners = new Map();\n\n  on(event, fn) {\n    const list = this.#listeners.get(event) ?? [];\n    list.push(fn);\n    this.#listeners.set(event, list);\n    return this;\n  }\n\n  off(event, fn) {\n    const list = this.#listeners.get(event);\n    if (list) this.#listeners.set(event, list.filter((f) => f !== fn));\n    return this;\n  }\n\n  once(event, fn) {\n    const wrapper = (...args) => {\n      this.off(event, wrapper);\n      fn(...args);\n    };\n    return this.on(event, wrapper);\n  }\n\n  emit(event, ...args) {\n    const list = [...(this.#listeners.get(event) ?? [])];\n    for (const fn of list) fn(...args);\n    return list.length;\n  }\n}\n` },
  }),
  mk({
    id: 'gen-deep-equal',
    prompt: 'Create src/deep-equal.js exporting deepEqual(a, b) that compares two values recursively: primitives by strict equality (NaN equals NaN), arrays element by element, plain objects by their own keys.',
    files: { ...PKG },
    tests: { 'test/deep-equal.test.js': test("import { deepEqual } from '../src/deep-equal.js';", `test('deepEqual', () => {\n  assert.equal(deepEqual(1, 1), true);\n  assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);\n  assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined }), false);\n  assert.equal(deepEqual([1, 2], [1, 2, 3]), false);\n  assert.equal(deepEqual([], {}), false);\n  assert.equal(deepEqual(NaN, NaN), true);\n  assert.equal(deepEqual(null, {}), false);\n  assert.equal(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);\n});`) },
    solution: { 'src/deep-equal.js': `export function deepEqual(a, b) {\n  if (Object.is(a, b)) return true;\n  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;\n  if (Array.isArray(a) !== Array.isArray(b)) return false;\n  const ka = Object.keys(a);\n  const kb = Object.keys(b);\n  if (ka.length !== kb.length) return false;\n  return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));\n}\n` },
  }),
  mk({
    id: 'gen-roman',
    prompt: 'Create src/roman.js exporting toRoman(n) (integers 1..3999 to a Roman numeral string) and fromRoman(s) (the reverse). toRoman throws a RangeError outside 1..3999.',
    files: { ...PKG },
    tests: { 'test/roman.test.js': test("import { toRoman, fromRoman } from '../src/roman.js';", `test('roman', () => {\n  assert.equal(toRoman(4), 'IV');\n  assert.equal(toRoman(1994), 'MCMXCIV');\n  assert.equal(toRoman(3999), 'MMMCMXCIX');\n  assert.equal(fromRoman('XLII'), 42);\n  assert.equal(fromRoman('MCMXCIV'), 1994);\n  for (const n of [1, 9, 14, 40, 90, 400, 2024]) assert.equal(fromRoman(toRoman(n)), n);\n  assert.throws(() => toRoman(0), RangeError);\n  assert.throws(() => toRoman(4000), RangeError);\n});`) },
    solution: { 'src/roman.js': `const TABLE = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];\n\nexport function toRoman(n) {\n  if (!Number.isInteger(n) || n < 1 || n > 3999) throw new RangeError('out of range');\n  let out = '';\n  for (const [v, s] of TABLE) while (n >= v) { out += s; n -= v; }\n  return out;\n}\n\nexport function fromRoman(s) {\n  let i = 0;\n  let n = 0;\n  for (const [v, sym] of TABLE) while (s.startsWith(sym, i)) { n += v; i += sym.length; }\n  return n;\n}\n` },
  }),
  mk({
    id: 'gen-binary-search',
    prompt: 'Create src/search.js exporting binarySearch(sorted, target) that returns the index of target in a sorted ascending array of numbers, or -1 if it is absent. Do not use indexOf or includes.',
    files: { ...PKG },
    tests: { 'test/search.test.js': test("import { binarySearch } from '../src/search.js';\nimport { readFileSync } from 'node:fs';", `test('binarySearch', () => {\n  const a = [1, 3, 5, 7, 9, 11];\n  for (const [i, v] of a.entries()) assert.equal(binarySearch(a, v), i);\n  assert.equal(binarySearch(a, 4), -1);\n  assert.equal(binarySearch([], 1), -1);\n  assert.equal(binarySearch([2], 2), 0);\n  assert.equal(binarySearch(a, 100), -1);\n  const src = readFileSync(new URL('../src/search.js', import.meta.url), 'utf8');\n  assert.doesNotMatch(src, /indexOf|includes/);\n});`) },
    solution: { 'src/search.js': `export function binarySearch(sorted, target) {\n  let lo = 0;\n  let hi = sorted.length - 1;\n  while (lo <= hi) {\n    const mid = (lo + hi) >> 1;\n    if (sorted[mid] === target) return mid;\n    if (sorted[mid] < target) lo = mid + 1;\n    else hi = mid - 1;\n  }\n  return -1;\n}\n` },
  }),
  mk({
    id: 'gen-flatten',
    prompt: 'Create src/flatten.js exporting flatten(arr, depth = Infinity) that flattens nested arrays up to the given depth without using Array.prototype.flat.',
    files: { ...PKG },
    tests: { 'test/flatten.test.js': test("import { flatten } from '../src/flatten.js';\nimport { readFileSync } from 'node:fs';", `test('flatten', () => {\n  assert.deepEqual(flatten([1, [2, [3, [4]]]]), [1, 2, 3, 4]);\n  assert.deepEqual(flatten([1, [2, [3, [4]]]], 1), [1, 2, [3, [4]]]);\n  assert.deepEqual(flatten([1, [2, [3]]], 0), [1, [2, [3]]]);\n  assert.deepEqual(flatten([]), []);\n  const src = readFileSync(new URL('../src/flatten.js', import.meta.url), 'utf8');\n  assert.doesNotMatch(src, /\\.flat\\(/);\n});`) },
    solution: { 'src/flatten.js': `export function flatten(arr, depth = Infinity) {\n  const out = [];\n  for (const x of arr) {\n    if (Array.isArray(x) && depth > 0) out.push(...flatten(x, depth - 1));\n    else out.push(x);\n  }\n  return out;\n}\n` },
  }),
  mk({
    id: 'gen-group-by',
    prompt: 'Создай src/group.js с функцией groupBy(items, keyFn): возвращает объект, где ключ — результат keyFn(item), а значение — массив элементов с этим ключом в исходном порядке.',
    files: { ...PKG },
    tests: { 'test/group.test.js': test("import { groupBy } from '../src/group.js';", `test('groupBy', () => {\n  assert.deepEqual(groupBy([1, 2, 3, 4, 5], (n) => (n % 2 ? 'odd' : 'even')), { odd: [1, 3, 5], even: [2, 4] });\n  assert.deepEqual(groupBy(['aa', 'b', 'cc'], (s) => s.length), { 2: ['aa', 'cc'], 1: ['b'] });\n  assert.deepEqual(groupBy([], (x) => x), {});\n});`) },
    solution: { 'src/group.js': `export function groupBy(items, keyFn) {\n  const out = {};\n  for (const item of items) (out[keyFn(item)] ??= []).push(item);\n  return out;\n}\n` },
  }),
  mk({
    id: 'gen-format-bytes',
    prompt: 'Create src/bytes.js exporting formatBytes(n) that returns a human readable size with 1 decimal when needed: 0 -> "0 B", 1023 -> "1023 B", 1024 -> "1 KB", 1536 -> "1.5 KB", then MB and GB (base 1024). Negative or non-finite input throws a RangeError.',
    files: { ...PKG },
    tests: { 'test/bytes.test.js': test("import { formatBytes } from '../src/bytes.js';", `test('formatBytes', () => {\n  assert.equal(formatBytes(0), '0 B');\n  assert.equal(formatBytes(1023), '1023 B');\n  assert.equal(formatBytes(1024), '1 KB');\n  assert.equal(formatBytes(1536), '1.5 KB');\n  assert.equal(formatBytes(1024 * 1024), '1 MB');\n  assert.equal(formatBytes(5.5 * 1024 ** 3), '5.5 GB');\n  assert.throws(() => formatBytes(-1), RangeError);\n  assert.throws(() => formatBytes(Infinity), RangeError);\n});`) },
    solution: { 'src/bytes.js': `export function formatBytes(n) {\n  if (!Number.isFinite(n) || n < 0) throw new RangeError('invalid size');\n  const units = ['B', 'KB', 'MB', 'GB'];\n  let i = 0;\n  while (n >= 1024 && i < units.length - 1) {\n    n /= 1024;\n    i++;\n  }\n  return String(Math.round(n * 10) / 10) + ' ' + units[i];\n}\n` },
  }),
  mk({
    id: 'gen-queue',
    prompt: 'Create src/queue.js exporting a class Queue with enqueue(x), dequeue() (undefined when empty), peek(), and a size getter. It must be O(1) per operation (do not use Array.shift).',
    files: { ...PKG },
    tests: { 'test/queue.test.js': test("import { Queue } from '../src/queue.js';\nimport { readFileSync } from 'node:fs';", `test('Queue', () => {\n  const q = new Queue();\n  assert.equal(q.dequeue(), undefined);\n  q.enqueue(1);\n  q.enqueue(2);\n  q.enqueue(3);\n  assert.equal(q.size, 3);\n  assert.equal(q.peek(), 1);\n  assert.equal(q.dequeue(), 1);\n  assert.equal(q.dequeue(), 2);\n  q.enqueue(4);\n  assert.equal(q.dequeue(), 3);\n  assert.equal(q.dequeue(), 4);\n  assert.equal(q.size, 0);\n  const src = readFileSync(new URL('../src/queue.js', import.meta.url), 'utf8');\n  assert.doesNotMatch(src, /shift\\(/);\n});`) },
    solution: { 'src/queue.js': `export class Queue {\n  #items = [];\n  #head = 0;\n\n  enqueue(x) {\n    this.#items.push(x);\n  }\n\n  dequeue() {\n    if (this.#head >= this.#items.length) return undefined;\n    const x = this.#items[this.#head];\n    this.#items[this.#head++] = undefined;\n    return x;\n  }\n\n  peek() {\n    return this.#items[this.#head];\n  }\n\n  get size() {\n    return this.#items.length - this.#head;\n  }\n}\n` },
  }),
  mk({
    id: 'gen-csv',
    prompt: 'Create src/csv.js exporting parseCsv(text) that parses CSV into an array of rows (arrays of strings). Support double-quoted fields containing commas, escaped quotes ("") and line breaks inside quotes. Rows are separated by \\n or \\r\\n; ignore a trailing empty line.',
    files: { ...PKG },
    tests: { 'test/csv.test.js': test("import { parseCsv } from '../src/csv.js';", `test('parseCsv', () => {\n  assert.deepEqual(parseCsv('a,b,c\\n1,2,3\\n'), [['a', 'b', 'c'], ['1', '2', '3']]);\n  assert.deepEqual(parseCsv('"x,y",z\\r\\n"he said ""hi""",w'), [['x,y', 'z'], ['he said "hi"', 'w']]);\n  assert.deepEqual(parseCsv('"line1\\nline2",b'), [['line1\\nline2', 'b']]);\n  assert.deepEqual(parseCsv('a,,c'), [['a', '', 'c']]);\n  assert.deepEqual(parseCsv(''), []);\n});`) },
    solution: { 'src/csv.js': `export function parseCsv(text) {\n  const rows = [];\n  let row = [];\n  let field = '';\n  let quoted = false;\n  for (let i = 0; i < text.length; i++) {\n    const c = text[i];\n    if (quoted) {\n      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }\n      else if (c === '"') quoted = false;\n      else field += c;\n    } else if (c === '"') quoted = true;\n    else if (c === ',') { row.push(field); field = ''; }\n    else if (c === '\\n' || c === '\\r') {\n      if (c === '\\r' && text[i + 1] === '\\n') i++;\n      row.push(field); rows.push(row); row = []; field = '';\n    } else field += c;\n  }\n  if (field !== '' || row.length) { row.push(field); rows.push(row); }\n  return rows;\n}\n` },
  }),
  mk({
    id: 'gen-word-frequency',
    prompt: 'Create src/words.js exporting topWords(text, n): the n most frequent words (lowercased, letters and apostrophes only) as an array of [word, count] pairs, sorted by count descending and then alphabetically.',
    files: { ...PKG },
    tests: { 'test/words.test.js': test("import { topWords } from '../src/words.js';", `test('topWords', () => {\n  const text = "The cat and the hat. The CAT sat; and it's the hat's day.";\n  assert.deepEqual(topWords(text, 3), [['the', 4], ['and', 2], ['cat', 2]]);\n  assert.deepEqual(topWords('', 5), []);\n  assert.deepEqual(topWords('b a b a c', 2), [['a', 2], ['b', 2]]);\n});`) },
    solution: { 'src/words.js': `export function topWords(text, n) {\n  const counts = new Map();\n  for (const w of text.toLowerCase().match(/[a-z']+/g) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1);\n  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);\n}\n` },
  }),
  mk({
    id: 'gen-password',
    prompt: 'Create src/password.js exporting validatePassword(pw) that returns an array of problems (empty array when valid). Rules and exact messages: length under 8 -> "too short"; no digit -> "needs a digit"; no uppercase letter -> "needs an uppercase letter"; contains whitespace -> "no spaces allowed". Report problems in that order.',
    files: { ...PKG },
    tests: { 'test/password.test.js': test("import { validatePassword } from '../src/password.js';", `test('validatePassword', () => {\n  assert.deepEqual(validatePassword('Secret123'), []);\n  assert.deepEqual(validatePassword('short'), ['too short', 'needs a digit', 'needs an uppercase letter']);\n  assert.deepEqual(validatePassword('longenough1'), ['needs an uppercase letter']);\n  assert.deepEqual(validatePassword('Has Space1x'), ['no spaces allowed']);\n});`) },
    solution: { 'src/password.js': `export function validatePassword(pw) {\n  const problems = [];\n  if (pw.length < 8) problems.push('too short');\n  if (!/\\d/.test(pw)) problems.push('needs a digit');\n  if (!/[A-Z]/.test(pw)) problems.push('needs an uppercase letter');\n  if (/\\s/.test(pw)) problems.push('no spaces allowed');\n  return problems;\n}\n` },
  }),
  mk({
    id: 'gen-date-diff',
    prompt: 'Create src/dates.js exporting daysBetween(a, b) for two ISO dates like "2024-02-27" (YYYY-MM-DD): the number of whole days from a to b (negative when b is earlier). Take leap years into account; do not depend on the local time zone.',
    files: { ...PKG },
    tests: { 'test/dates.test.js': test("import { daysBetween } from '../src/dates.js';", `test('daysBetween', () => {\n  assert.equal(daysBetween('2024-01-01', '2024-01-02'), 1);\n  assert.equal(daysBetween('2024-02-27', '2024-03-01'), 3);\n  assert.equal(daysBetween('2023-02-27', '2023-03-01'), 2);\n  assert.equal(daysBetween('2024-03-01', '2024-02-27'), -3);\n  assert.equal(daysBetween('2020-01-01', '2021-01-01'), 366);\n  assert.equal(daysBetween('2024-05-05', '2024-05-05'), 0);\n});`) },
    solution: { 'src/dates.js': `const toUtc = (s) => {\n  const [y, m, d] = s.split('-').map(Number);\n  return Date.UTC(y, m - 1, d);\n};\n\nexport function daysBetween(a, b) {\n  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);\n}\n` },
  }),
  mk({
    id: 'gen-matrix',
    prompt: 'Create src/matrix.js exporting transpose(m) and multiply(a, b) for matrices given as arrays of rows of numbers. multiply throws an Error if the inner dimensions do not match.',
    files: { ...PKG },
    tests: { 'test/matrix.test.js': test("import { transpose, multiply } from '../src/matrix.js';", `test('matrix', () => {\n  assert.deepEqual(transpose([[1, 2, 3], [4, 5, 6]]), [[1, 4], [2, 5], [3, 6]]);\n  assert.deepEqual(transpose([]), []);\n  assert.deepEqual(multiply([[1, 2], [3, 4]], [[5, 6], [7, 8]]), [[19, 22], [43, 50]]);\n  assert.deepEqual(multiply([[1, 2, 3]], [[1], [2], [3]]), [[14]]);\n  assert.throws(() => multiply([[1, 2]], [[1, 2]]), Error);\n});`) },
    solution: { 'src/matrix.js': `export function transpose(m) {\n  if (m.length === 0) return [];\n  return m[0].map((_, j) => m.map((row) => row[j]));\n}\n\nexport function multiply(a, b) {\n  if (a[0].length !== b.length) throw new Error('dimension mismatch');\n  return a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));\n}\n` },
  }),
];
