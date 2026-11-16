/**
 * Lecteur du fichier HILIA_DONNEES.jsonl.
 *
 * Le fichier est presque du NDJSON, mais certaines descriptions contiennent un
 * retour à la ligne brut : une fiche peut donc occuper plusieurs lignes. On
 * recolle les fragments en échappant la coupure, ce qui restitue le \n attendu
 * dans la chaîne JSON. Un enregistrement valide n'est jamais deviné : toute
 * autre erreur de syntaxe arrête l'import.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const INCOMPLETE = /Unterminated string|Unexpected end of JSON input/i;

export async function* readHiliaJsonl(path, { maxRecordBytes = 8 * 1024 * 1024 } = {}) {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let buffer = '';
  let startLine = 0;
  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!buffer && !line.trim()) continue;
      if (!buffer) startLine = lineNumber;
      // Une coupure dans une chaîne doit devenir un vrai \n JSON. On écrit deux
      // caractères (barre oblique + n), pas un saut de ligne littéral.
      buffer = buffer ? `${buffer}\\n${line}` : line;
      if (Buffer.byteLength(buffer, 'utf8') > maxRecordBytes) {
        throw new Error(`Enregistrement trop volumineux lignes ${startLine}-${lineNumber} (${maxRecordBytes} octets max).`);
      }
      try {
        const record = JSON.parse(buffer);
        yield { record, startLine, endLine: lineNumber, repaired: lineNumber > startLine };
        buffer = '';
        startLine = 0;
      } catch (error) {
        if (error instanceof SyntaxError && INCOMPLETE.test(error.message)) continue;
        throw new Error(`JSONL invalide lignes ${startLine}-${lineNumber} : ${error.message}`);
      }
    }
    if (buffer.trim()) {
      throw new Error(`Enregistrement JSON incomplet à la fin du fichier (ligne ${startLine}).`);
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

/** Parcourt le fichier et renvoie les compteurs de contrôle du manifeste. */
export async function scanHiliaJsonl(path, visit) {
  const counts = Object.create(null);
  let records = 0;
  let repaired = 0;
  let manifest = null;
  const samples = Object.create(null);

  for await (const item of readHiliaJsonl(path)) {
    records += 1;
    if (item.repaired) repaired += 1;
    const kind = item.record?.kind || 'unknown';
    counts[kind] = (counts[kind] || 0) + 1;
    if (kind === 'manifest') manifest = item.record;
    if (!samples[kind]) samples[kind] = item.record;
    if (visit) await visit(item.record, item, counts);
  }
  return { records, repaired, counts, manifest, samples };
}
