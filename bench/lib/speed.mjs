import { createHash } from 'node:crypto';
import { SCENARIOS } from './fixtures.mjs';

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Один запрос потоком. Показатели берём из `timings` llama-server, а если их нет
 * (MLX, Ollama и другие OpenAI-совместимые серверы), считаем по часам клиента.
 */
export async function measureOnce(baseUrl, scenario, { cachePrompt = false, model } = {}) {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(model ? { model } : {}),
      messages: scenario.messages(),
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      max_tokens: scenario.maxTokens,
      cache_prompt: cachePrompt,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  let tFirst = null;
  let tLast = t0;
  let chunks = 0;
  let text = '';
  let timings = null;
  let usage = null;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const part of res.body) {
    buf += decoder.decode(part, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of ev.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const j = JSON.parse(data);
        if (j.timings) timings = j.timings;
        if (j.usage) usage = j.usage;
        const delta = j.choices?.[0]?.delta;
        const piece = (delta?.content ?? '') + (delta?.reasoning_content ?? '');
        if (piece) {
          tLast = performance.now();
          tFirst ??= tLast;
          chunks++;
          text += delta?.content ?? '';
        }
      }
    }
  }
  const wallMs = performance.now() - t0;
  const predicted = timings?.predicted_n ?? usage?.completion_tokens ?? chunks;
  const clientDecode = tFirst && predicted > 1 ? (predicted - 1) / ((tLast - tFirst) / 1000) : null;
  return {
    promptTokens: timings?.prompt_n != null ? timings.prompt_n + (timings.cache_n ?? 0) : usage?.prompt_tokens ?? null,
    cachedTokens: timings?.cache_n ?? null,
    promptTps: timings?.prompt_per_second ?? null,
    predictedTokens: predicted,
    decodeTps: timings?.predicted_per_second ?? clientDecode,
    clientDecodeTps: clientDecode,
    ttftMs: tFirst ? tFirst - t0 : null,
    wallMs,
    draft: timings && 'draft_n' in timings ? { n: timings.draft_n, accepted: timings.draft_n_accepted } : null,
    outputHash: createHash('sha1').update(text).digest('hex').slice(0, 10),
  };
}

/** Прогоняет сценарии: один прогрев, затем `runs` замеров. Возвращает медианы. */
export async function runScenarios(baseUrl, names, { runs = 3, model, log = console.log } = {}) {
  const out = {};
  for (const name of names) {
    const sc = SCENARIOS[name];
    log(`  • ${sc.title}`);
    await measureOnce(baseUrl, { ...sc, maxTokens: Math.min(sc.maxTokens, 16) }, { model }).catch(() => {}); // прогрев
    const rs = [];
    for (let i = 0; i < runs; i++) {
      const r = await measureOnce(baseUrl, sc, { cachePrompt: false, model });
      rs.push(r);
      log(`    #${i + 1}: декод ${r.decodeTps?.toFixed(1)} ток/с, префилл ${r.promptTps?.toFixed(0) ?? '—'} ток/с, ${r.predictedTokens} ток., ${(r.wallMs / 1000).toFixed(1)} с`);
    }
    const entry = {
      runs: rs,
      decodeTps: median(rs.map((r) => r.decodeTps)),
      promptTps: median(rs.map((r) => r.promptTps)),
      ttftMs: median(rs.map((r) => r.ttftMs)),
      predictedTokens: median(rs.map((r) => r.predictedTokens)),
      deterministic: new Set(rs.map((r) => r.outputHash)).size === 1,
      outputHash: rs[0].outputHash,
    };
    if (sc.minPredicted && entry.predictedTokens < sc.minPredicted) {
      entry.warning = `модель выдала всего ${entry.predictedTokens} токенов (< ${sc.minPredicted}): скорость менее надёжна`;
      log(`    ! ${entry.warning}`);
    }
    // тёплый кэш префикса: тот же запрос повторно, как в шагах цикла агента
    if (name === 'edit' || name.startsWith('prefill')) {
      await measureOnce(baseUrl, sc, { cachePrompt: true, model }).catch(() => {});
      const warm = await measureOnce(baseUrl, sc, { cachePrompt: true, model });
      entry.warmTtftMs = warm.ttftMs;
      entry.warmCachedTokens = warm.cachedTokens;
      log(`    с кэшем префикса: первый токен через ${warm.ttftMs?.toFixed(0)} мс (холодный: ${entry.ttftMs?.toFixed(0)} мс)`);
    }
    out[name] = entry;
  }
  return out;
}
