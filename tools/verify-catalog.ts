// Сверяет каталог моделей (packages/host/src/model-catalog.ts) с самим Hugging Face: коммит, размер и SHA-256 каждого файла.
// Запуск: node --experimental-strip-types tools/verify-catalog.ts   (нужна сеть до huggingface.co; HF_ENDPOINT для зеркала)
import { MODEL_CATALOG } from '../packages/host/src/model-catalog.ts';

const base = (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/$/, '');
let bad = 0;
for (const { spec } of MODEL_CATALOG) {
  const res = await fetch(`${base}/api/models/${spec.repo}/revision/${spec.revision}?blobs=true`);
  if (!res.ok) {
    console.log(`НЕТ   ${spec.id}: ${spec.repo}@${spec.revision.slice(0, 8)} HTTP ${res.status}`);
    bad++;
    continue;
  }
  const info = (await res.json()) as { sha?: string; siblings?: { rfilename: string; size?: number; lfs?: { sha256?: string; size?: number } }[] };
  if (info.sha !== spec.revision) {
    console.log(`КОММИТ ${spec.id}: в каталоге ${spec.revision}, на сайте ${info.sha}`);
    bad++;
  }
  for (const f of spec.files) {
    const s = info.siblings?.find((x) => x.rfilename === f.name);
    const size = s?.lfs?.size ?? s?.size;
    const sha = s?.lfs?.sha256;
    if (!s) console.log(`НЕТ   ${spec.id}: файла ${f.name} нет в репозитории`), bad++;
    else if (size !== f.size || sha !== f.sha256) console.log(`РАЗНО ${spec.id}/${f.name}: каталог ${f.size} ${f.sha256}; сайт ${size} ${sha}`), bad++;
    else console.log(`OK    ${spec.id}/${f.name} (${(f.size / 2 ** 30).toFixed(2)} ГБ)`);
  }
}
console.log(bad ? `\nРасхождений: ${bad}` : '\nКаталог совпадает с Hugging Face');
process.exit(bad ? 1 : 0);
