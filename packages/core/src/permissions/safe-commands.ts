/** Команды, которые только читают: их можно запускать без подтверждения. */
const SAFE_SIMPLE = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'which', 'whoami', 'date', 'uname', 'file', 'stat', 'du', 'df', 'tree',
  'grep', 'egrep', 'fgrep', 'rg', 'sort', 'uniq', 'cut', 'tr', 'diff', 'basename', 'dirname', 'realpath', 'true', 'printenv',
]);
const SAFE_GIT = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'remote', 'describe', 'shortlog']);
const SAFE_VERSION_FLAGS = new Set(['--version', '-v', '-V', 'version']);

function stripQuotes(s: string): string {
  return s.replace(/^(['"])(.*)\1$/, '$2');
}

function safeSegment(seg: string): boolean {
  const tokens = seg.trim().split(/\s+/).map(stripQuotes);
  const cmd = tokens[0];
  if (!cmd) return false;
  if (SAFE_SIMPLE.has(cmd)) return cmd !== 'sort' || !tokens.some((t) => t === '-o' || t.startsWith('--output'));
  if (cmd === 'git') {
    const sub = tokens.find((t, i) => i > 0 && !t.startsWith('-'));
    if (!sub || !SAFE_GIT.has(sub)) return false;
    if (sub === 'branch') return tokens.slice(2).every((t) => ['-a', '-r', '-v', '-vv', '--list', '--show-current'].includes(t));
    if (sub === 'remote') return tokens.slice(2).every((t) => ['-v', 'show'].includes(t) || t === 'get-url');
    return true;
  }
  if (cmd === 'find') return !tokens.some((t) => ['-exec', '-execdir', '-delete', '-ok', '-fprint', '-fprintf'].includes(t));
  if (cmd === 'sed') return tokens.includes('-n') && !tokens.some((t) => t === '-i' || t.startsWith('-i'));
  if (['node', 'npm', 'python', 'python3', 'pip', 'cargo', 'go', 'rustc', 'tsc', 'java'].includes(cmd)) {
    return tokens.length === 2 && SAFE_VERSION_FLAGS.has(tokens[1]!);
  }
  return false;
}

/**
 * Безопасна ли командная строка целиком. Запись в файл, подстановки, фоновый запуск и составные
 * команды с небезопасными частями отвергаются.
 */
export function isSafeCommand(command: string): boolean {
  const c = command.trim();
  if (!c || /[`<>\n]|\$\(|\$\{|&\s*$/.test(c)) return false;
  return c.split(/\|\||&&|;|\|/).every(safeSegment);
}

const SECRET_MENTION = /(^|[\s/'"=])\.env(\.[\w-]+)?($|[\s'"])|\.ssh\b|id_(rsa|dsa|ecdsa|ed25519)|\.aws\b|\.gnupg|\.kube\b|\.pem\b|\.p12\b|\.netrc|\.npmrc|Keychains|Application Support\/(Google|Firefox)|\.mozilla|google-chrome/i;

/** Команда упоминает секреты или хранилища браузеров: автоматически запускать её нельзя, даже если она «читающая». */
export function mentionsSecret(command: string): boolean {
  return SECRET_MENTION.test(command);
}
