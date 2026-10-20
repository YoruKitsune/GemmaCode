import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const f1 = (x) => (x == null ? '—' : x.toFixed(1));
const f0 = (x) => (x == null ? '—' : x.toFixed(0));
const gb = (b) => (b ? (b / 2 ** 30).toFixed(2) : '—');

/** Берёт последний файл на каждую пару (вид, тег): имя файла = вид__тег__метка-времени. */
function loadLatest(dir) {
  const latest = new Map();
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const [kind, tag] = name.split('__');
    const rec = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const prev = latest.get(`${kind}__${tag}`);
    // более поздний неполный запуск (например, только chat и edit) не должен затирать полный
    if (prev && !rec.error && Object.keys(rec.scenarios ?? {}).length < Object.keys(prev.scenarios ?? {}).length) continue;
    latest.set(`${kind}__${tag}`, rec);
  }
  return [...latest.values()];
}

export function writeReport(dir, cfg) {
  const recs = loadLatest(dir);
  const speed = recs.filter((r) => r.kind === 'speed' && !r.error);
  const tools = recs.filter((r) => r.kind === 'tools' && !r.error);
  const media = recs.filter((r) => r.kind === 'media' && !r.error);
  const failed = recs.filter((r) => r.error);
  const L = [];

  L.push('# Отчёт M0: замеры на целевой машине', '');
  const sys = speed[0]?.system ?? {};
  L.push(`Машина: ${sys.cpu ?? '?'}, ${sys.memGB ?? '?'} ГБ, macOS ${sys.os ?? '?'}; питание: ${sys.power ?? '?'}; режим низкого энергопотребления: ${sys.lowPowerMode ?? '?'}.`);
  L.push(`Движок: ${sys.llama ?? '?'}. ffmpeg: ${sys.ffmpeg ?? 'нет'}.`, '');

  L.push('## Скорость', '');
  L.push('Декод — медиана ток/с по серверным таймингам (для спекулятивного режима это эффективная скорость). Префилл — ток/с обработки промпта.', '');
  L.push('| Квант | ГБ | Spec | Декод чат | Декод правка | Префилл 2K | Префилл 8K | Первый токен 8K (хол./кэш), мс | Пик RSS, МБ | Своп, МБ | Замечания |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  const rows = [...speed].sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0) || String(a.spec).localeCompare(b.spec));
  for (const r of rows) {
    const s = r.scenarios ?? {};
    const noneOut = speed.find((x) => x.quant === r.quant && x.spec === 'none')?.scenarios?.edit?.outputHash;
    const notes = [r.modelMismatch ? 'НЕ ТОТ ФАЙЛ' : null, r.swapDeltaMB > 300 ? 'своп вырос' : null, r.spec !== 'none' && noneOut && s.edit && s.edit.outputHash !== noneOut ? 'вывод отличается от spec=none' : null, s.edit && !s.edit.deterministic ? 'правка недетерминирована' : null, s.edit?.warning, Number(/CPU_Speed_Limit\s*=\s*(\d+)/i.exec(r.thermal ?? '')?.[1] ?? 100) < 100 ? 'троттлинг' : null].filter(Boolean).join('; ');
    L.push(`| ${r.quant} | ${gb(r.sizeBytes)} | ${r.spec} | ${f1(s.chat?.decodeTps)} | ${f1(s.edit?.decodeTps)} | ${f0(s.prefill2k?.promptTps)} | ${f0(s.prefill8k?.promptTps)} | ${f0(s.prefill8k?.ttftMs)} / ${f0(s.prefill8k?.warmTtftMs)} | ${r.rssPeakMB ?? '—'} | ${r.swapDeltaMB == null ? '—' : Math.round(r.swapDeltaMB)} | ${notes} |`);
  }
  for (const r of recs.filter((x) => x.kind === 'speed' && x.external)) {
    const s = r.scenarios;
    L.push(`| ${r.label} (внешний) | — | — | ${f1(s.chat?.decodeTps)} | ${f1(s.edit?.decodeTps)} | ${f0(s.prefill2k?.promptTps)} | ${f0(s.prefill8k?.promptTps)} | ${f0(s.prefill8k?.ttftMs)} / ${f0(s.prefill8k?.warmTtftMs)} | — | — | |`);
  }
  L.push('');

  L.push('## Надёжность вызовов инструментов', '');
  L.push('| Квант | ГБ | native, % | schema, % | Основные ошибки (native) |');
  L.push('|---|---|---|---|---|');
  const toolRows = [...tools].sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0));
  for (const r of toolRows) {
    const n = r.results?.native;
    const s = r.results?.schema;
    L.push(`| ${r.quant} | ${gb(r.sizeBytes)} | ${n ? `${(n.rate * 100).toFixed(0)} (${n.ok}/${n.n})` : '—'} | ${s ? `${(s.rate * 100).toFixed(0)} (${s.ok}/${s.n})` : '—'} | ${n ? Object.entries(n.reasons).map(([k, v]) => `${k}: ${v}`).join(', ') : ''} |`);
  }
  L.push('');

  // Правило из плана: самый лёгкий квант, у которого успех не ниже эталонного больше чем на N п.п.
  L.push('## Выбор квантования', '');
  const ref = toolRows.find((r) => r.quant === cfg.referenceQuant);
  const mode = ref?.results?.native ? 'native' : ref?.results?.schema ? 'schema' : null;
  let pick = null;
  if (!ref || !mode) L.push(`Правило не применить: нет результатов для эталона ${cfg.referenceQuant}.`);
  else {
    const refRate = ref.results[mode].rate;
    const ok = toolRows.filter((r) => r.results?.[mode] && (refRate - r.results[mode].rate) * 100 <= cfg.toolSuccessMarginPp);
    pick = ok[0];
    L.push(`Эталон ${cfg.referenceQuant}: ${(refRate * 100).toFixed(0)}% (режим ${mode}). Допустимое падение: ${cfg.toolSuccessMarginPp} п.п.`);
    L.push(`Подходят: ${ok.map((r) => `${r.quant} (${(r.results[mode].rate * 100).toFixed(0)}%)`).join(', ') || 'никто'}.`);
    L.push(pick ? `**Самый лёгкий подходящий: ${pick.quant}** (${gb(pick.sizeBytes)} ГБ).` : '**Ни один квант не прошёл правило.**');
  }
  L.push('');

  L.push('## Гейт по скорости', '');
  const best = (key) => speed.filter((r) => !r.modelMismatch).map((r) => ({ r, v: r.scenarios?.[key]?.decodeTps ?? 0 })).sort((a, b) => b.v - a.v)[0];
  const pure = speed.filter((r) => r.spec === 'none' && !r.modelMismatch).map((r) => ({ r, v: r.scenarios?.chat?.decodeTps ?? 0 })).sort((a, b) => b.v - a.v)[0];
  const eff = best('edit');
  L.push(`Цель: ${cfg.targetTps} ток/с.`);
  L.push(pure ? `- Чистый декод (чат, без spec): лучший ${f1(pure.v)} ток/с на ${pure.r.quant} — ${pure.v >= cfg.targetTps ? 'цель достигнута' : `не хватает ${f1(cfg.targetTps - pure.v)}`}.` : '- Нет данных по чистому декоду.');
  L.push(eff ? `- Эффективная скорость на правке файла: лучшая ${f1(eff.v)} ток/с на ${eff.r.quant} со spec=${eff.r.spec} — ${eff.v >= cfg.targetTps ? 'цель достигнута' : `не хватает ${f1(cfg.targetTps - eff.v)}`}.` : '- Нет данных по правке файла.');
  L.push('');

  if (media.length) {
    L.push('## Мультимодальность', '');
    for (const m of media) {
      L.push(`${m.quant}: пик RSS ${m.rssPeakMB} МБ с проектором; модальности сервера: ${JSON.stringify(m.modalities)}`);
      for (const [k, v] of Object.entries(m.results ?? {})) L.push(`- ${k}: ${v.pass ? 'работает' : 'НЕ прошло'} (HTTP ${v.status}, ${v.seconds?.toFixed(1)} с). Ответ: «${v.text.replace(/\s+/g, ' ').slice(0, 140)}»`);
    }
    L.push('');
  }
  if (failed.length) {
    L.push('## Сбои запусков', '');
    for (const r of failed) L.push(`- ${r.kind} ${r.quant ?? ''} ${r.spec ?? ''}: ${r.error}`);
    L.push('');
  }

  const file = join(dir, 'REPORT.md');
  writeFileSync(file, `${L.join('\n')}\n`);
  return file;
}
