import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Запускает команду и возвращает stdout+stderr или null, если команды нет. */
export async function sh(cmd, args = [], timeout = 15_000) {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout, maxBuffer: 8 << 20 });
    return `${stdout}${stderr}`.trim();
  } catch (e) {
    if (e.stdout || e.stderr) return `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
    return null;
  }
}

/** Снимок состояния машины: нужен, чтобы результаты замеров можно было сравнивать. */
export async function systemInfo(llamaBin) {
  const mem = await sh('sysctl', ['-n', 'hw.memsize']);
  return {
    when: new Date().toISOString(),
    cpu: await sh('sysctl', ['-n', 'machdep.cpu.brand_string']),
    memGB: mem ? Math.round(Number(mem) / 2 ** 30) : null,
    os: await sh('sw_vers', ['-productVersion']),
    power: (await sh('pmset', ['-g', 'batt']))?.split('\n')[0] ?? null,
    lowPowerMode: (await sh('pmset', ['-g']))?.match(/lowpowermode\s+(\d)/)?.[1] ?? null,
    llama: (await sh(llamaBin, ['--version']))?.split('\n').filter(Boolean).pop() ?? null,
    ffmpeg: (await sh('ffmpeg', ['-version']))?.split('\n')[0] ?? null,
  };
}

/** Признаки троттлинга (у MacBook Air нет вентилятора, так что это важно). */
export async function thermalState() {
  return (await sh('pmset', ['-g', 'therm'])) ?? 'n/a';
}

export async function swapUsedMB() {
  const out = await sh('sysctl', ['-n', 'vm.swapusage']);
  const m = out?.match(/used = ([\d.]+)M/);
  return m ? Number(m[1]) : null;
}

export async function rssMB(pid) {
  const out = await sh('ps', ['-o', 'rss=', '-p', String(pid)]);
  const kb = Number(out);
  return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null;
}
