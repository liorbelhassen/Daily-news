import { readSource, sourcesFrom } from './ingest.js';

const sources = await sourcesFrom(process.env.SOURCES_FILE);
const results = await Promise.allSettled(sources.map(source => readSource(source, Date.now())));
for (const [index, result] of results.entries()) {
  const { name } = sources[index];
  if (result.status === 'rejected') {
    console.error(`${name}: ${result.reason.message}`);
    process.exitCode = 1;
    continue;
  }
  const { scanned, candidates } = result.value;
  console.info(`${name}: ${scanned} entries parsed, ${candidates.length} fresh in scope`);
}
