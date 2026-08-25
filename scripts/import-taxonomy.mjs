#!/usr/bin/env node
/**
 * Converts the taxonomy workbook into the versioned JSON the application ships
 * with (`server/db/taxonomy/taxonomy.json`).
 *
 *   node scripts/import-taxonomy.mjs <workbook.xlsx> [--out <path>] [--sheet <name>]
 *
 * The workbook has one row per Area:
 *
 *   Subject | Area | Sub Areas (comma separated, optional) | Tags (comma separated)
 *
 * Splitting is bracket-aware: a tag such as
 * "Page Replacement (FIFO, LRU, Optimal, LFU)" contains commas that are part of
 * the tag, not separators. A naive split shreds 265 tags in the supplied file.
 *
 * Requires the `xlsx` package, which is a devDependency — the generated JSON is
 * committed, so a normal install or deployment never needs it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(here, '..', 'server', 'db', 'taxonomy', 'taxonomy.json');

/** Splits on commas that are not inside brackets. */
export function splitList(value) {
  if (value === null || value === undefined) return [];
  const out = [];
  let buffer = '';
  let depth = 0;

  for (const char of String(value)) {
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);

    if (char === ',' && depth === 0) {
      if (buffer.trim()) out.push(buffer.trim());
      buffer = '';
    } else {
      buffer += char;
    }
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

/** Builds the nested taxonomy from the workbook's flat rows. */
export function buildTaxonomy(rows) {
  const subjects = new Map();

  rows.forEach((row, index) => {
    const subjectName = String(row.Subject ?? '').trim();
    const areaName = String(row.Area ?? '').trim();
    if (!subjectName || !areaName) return;

    if (!subjects.has(subjectName)) {
      subjects.set(subjectName, { name: subjectName, position: subjects.size + 1, areas: [] });
    }
    const subject = subjects.get(subjectName);

    const subAreas = splitList(row['Sub Areas']);
    const tags = splitList(row.Tags);

    subject.areas.push({
      name: areaName,
      position: subject.areas.length + 1,
      sourceRow: index + 2, // 1-based, plus the header row
      subAreas: subAreas.map((name, i) => ({ name, position: i + 1 })),
      tags,
    });
  });

  const list = [...subjects.values()];
  const areas = list.flatMap((s) => s.areas);

  return {
    version: 1,
    generatedFrom: null,
    generatedAt: new Date().toISOString(),
    stats: {
      subjects: list.length,
      areas: areas.length,
      areasWithSubAreas: areas.filter((a) => a.subAreas.length > 0).length,
      subAreas: areas.reduce((acc, a) => acc + a.subAreas.length, 0),
      // A "question category" is the deepest node a QID can be mapped to:
      // the area itself when it has no sub-areas, otherwise each sub-area.
      leafCategories: areas.reduce((acc, a) => acc + (a.subAreas.length || 1), 0),
      tagMentions: areas.reduce((acc, a) => acc + a.tags.length, 0),
      distinctTags: new Set(areas.flatMap((a) => a.tags)).size,
    },
    subjects: list,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const source = args.find((a) => !a.startsWith('--'));
  if (!source) {
    console.error('Usage: node scripts/import-taxonomy.mjs <workbook.xlsx> [--out <path>] [--sheet <name>]');
    process.exit(1);
  }

  const readArg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };
  const out = path.resolve(readArg('out', DEFAULT_OUT));

  let XLSX;
  try {
    XLSX = (await import('xlsx')).default ?? (await import('xlsx'));
  } catch {
    console.error('The "xlsx" package is required to re-import the workbook: npm install --save-dev xlsx');
    process.exit(1);
  }

  const workbook = XLSX.readFile(source);
  const sheetName = readArg('sheet', workbook.SheetNames[0]);
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    console.error(`Sheet "${sheetName}" not found. Available: ${workbook.SheetNames.join(', ')}`);
    process.exit(1);
  }

  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  const taxonomy = buildTaxonomy(rows);
  taxonomy.generatedFrom = path.basename(source);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(taxonomy, null, 2)}\n`);

  console.log(`Wrote ${out}`);
  for (const [key, value] of Object.entries(taxonomy.stats)) {
    console.log(`  ${key.padEnd(20)} ${value}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
