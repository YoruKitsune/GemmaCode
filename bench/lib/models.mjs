/**
 * Подбор GGUF-файла под квантование. llama-server с `-hf repo:QUANT` молча берёт
 * первый файл репозитория, если нужного нет, поэтому файл выбираем сами по списку
 * файлов репозитория и передаём явно через -hff.
 */
export async function resolveGguf(repos, quant) {
  const want = quant.toLowerCase();
  const tried = [];
  for (const repo of repos) {
    let tree;
    try {
      const headers = process.env.HF_TOKEN ? { authorization: `Bearer ${process.env.HF_TOKEN}` } : {};
      const r = await fetch(`https://huggingface.co/api/models/${repo}/tree/main`, { headers });
      if (!r.ok) {
        tried.push(`${repo}: HTTP ${r.status}`);
        continue;
      }
      tree = await r.json();
    } catch (e) {
      tried.push(`${repo}: ${e.message}`);
      continue;
    }
    const files = tree.filter((f) => f.type === 'file' && f.path.toLowerCase().endsWith('.gguf') && !/mmproj/i.test(f.path));
    // имя файла заканчивается на -<quant>.gguf (Q4_K_M, Q8_0, а у Unsloth ещё и UD-Q4_K_XL)
    const hit = files.find((f) => f.path.toLowerCase().replace(/\.gguf$/, '').split(/[-.]/).includes(want) || f.path.toLowerCase().endsWith(`-${want}.gguf`) || f.path.toLowerCase().endsWith(`_${want}.gguf`));
    if (hit) return { repo, file: hit.path, sizeBytes: hit.size ?? hit.lfs?.size ?? null };
    tried.push(`${repo}: нет файла ${quant} среди ${files.map((f) => f.path).join(', ') || '(пусто)'}`);
  }
  throw new Error(`не нашёл GGUF для ${quant}:\n  ${tried.join('\n  ')}`);
}
