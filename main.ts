// main.ts is mend, the CLI SPEC.md specifies (version 1). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// It does all of SPEC.md: the command line, the output and exit codes, safe paths, format detection,
// JSON edits (section 9) and the all-or-nothing write (section 10), plus the three other formats:
// unified diffs (section 6), SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), with
// line matching at three tiers (section 5).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- Files, lines and matching (SPEC sections 3 and 5) ----------

interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  if (tier === 1) return t;
  return t.replace(/^[ \t]+/, '');
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** All 0-based positions at or after `from` where O occurs in `lines` at `tier`. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const on = o.map((l) => normLine(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions, or null. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  for (const t of tiers(strict)) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: `text` is patch text, or the file's own matched line when `ctx` is set. */
interface NItem {
  text: string;
  ctx: number | null;
}

/** Render N at match position `pos`: context lines come from the file, tier-2 re-indent applies. */
function renderN(fileLines: string[], pos: number, o: string[], n: NItem[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWs(fileLines[pos] ?? '');
    p = leadingWs(o[0]!);
  }
  for (const it of n) {
    if (it.ctx !== null) {
      out.push(fileLines[pos + it.ctx]!);
      continue;
    }
    let t = it.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

// One body line of a unified hunk or a V4A chunk. `kind` is the leading marker
// (' ' context, '-' old, '+' new, '\\' no-newline marker); `raw` is the patch line.
interface BodyLine {
  kind: string;
  text: string;
  raw: string;
}

function bodyLine(l: string): BodyLine {
  return { kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1), raw: l };
}

/** Split a hunk/chunk body into old lines O and new lines N (with context mapping). */
function splitBody(body: BodyLine[]): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  let oIdx = 0;
  for (const b of body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: oIdx });
      oIdx++;
    } else if (b.kind === '-') {
      o.push(b.text);
      oIdx++;
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: null });
    }
  }
  return { o, n };
}

// ---------- Unified diffs (SPEC section 6) ----------

interface Hunk {
  a: number;
  body: BodyLine[];
  noEol: boolean;
  o: string[];
  n: NItem[];
}

interface Section {
  hdrOld: string | null | undefined;
  hdrNew: string | null | undefined;
  renOld: string | null | undefined;
  renNew: string | null | undefined;
  gitOld: string | null | undefined;
  gitNew: string | null | undefined;
  flagCreate: boolean;
  flagDelete: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

/** The path of a `--- ` / `+++ ` line, or null for /dev/null. */
function headerPath(l: string): string | null {
  const p = (l.slice(4).split('\t')[0] ?? '').trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseHunk(lines: string[], h: number, section: Section): number {
  const m = HUNK_RE.exec(lines[h]!);
  if (m === null) throw new Exit2(`error: parse ${h + 1}`);
  const a = parseInt(m[1]!, 10);
  let j = h + 1;
  const body: BodyLine[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(bodyLine(l));
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
  let noEol = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === ' ' || body[k]!.kind === '+') {
      noEol = body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
      break;
    }
  }
  const { o, n } = splitBody(body);
  section.hunks.push({ a, body, noEol, o, n });
  return j;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const newSection = (): Section => {
    const s: Section = {
      hdrOld: undefined, hdrNew: undefined, renOld: undefined, renNew: undefined,
      gitOld: undefined, gitNew: undefined, flagCreate: false, flagDelete: false, hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        if (cur.hdrOld === undefined) cur.hdrOld = headerPath(line);
        if (cur.hdrNew === undefined) cur.hdrNew = headerPath(lines[i + 1]!);
      } else {
        const s = newSection();
        s.hdrOld = headerPath(line);
        s.hdrNew = headerPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      i = parseHunk(lines, i, cur);
      inHeader = false;
      continue;
    }
    if (cur === null) {
      i++;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        if (cur.hdrNew === undefined) cur.hdrNew = headerPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (cur.renOld === undefined) cur.renOld = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (cur.renNew === undefined) cur.renNew = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.flagCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.flagDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections;
}

function resolvePath(hdr: string | null | undefined, ren: string | null | undefined, git: string | null | undefined): string | null {
  if (hdr !== undefined) return hdr;
  if (ren !== undefined) return ren;
  if (git !== undefined) return git;
  return null;
}

function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((s) => {
    const oldP = resolvePath(s.hdrOld, s.renOld, s.gitOld);
    const newP = resolvePath(s.hdrNew, s.renNew, s.gitNew);
    const isCreate = (oldP === null || s.flagCreate) && newP !== null;
    const isDelete = !isCreate && (newP === null || s.flagDelete) && oldP !== null;
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    if (isCreate) {
      const np = newP!;
      return (tree: Tree) => {
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        let noEol = false;
        for (const h of s.hunks) {
          let lastPlus = -1;
          for (let k = 0; k < h.body.length; k++) if (h.body[k]!.kind === '+') lastPlus = k;
          if (lastPlus >= 0) noEol = h.body[lastPlus + 1] !== undefined && h.body[lastPlus + 1]!.kind === '\\';
          for (const b of h.body) if (b.kind === '+') plus.push(b.text);
        }
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      };
    }
    if (isDelete) {
      const op = oldP!;
      return (tree: Tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      };
    }
    const op = oldP ?? '';
    const np = newP ?? '';
    return (tree: Tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (isMove && !safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
      let model = splitFile(before);
      let d = 0;
      for (const h of s.hunks) {
        if (h.o.length === 0) {
          let pos = h.a + d;
          if (pos < 0) pos = 0;
          if (pos > model.lines.length) pos = model.lines.length;
          const atEnd = pos === model.lines.length;
          const rendered = h.n.map((it) => it.text);
          model.lines = [...model.lines.slice(0, pos), ...rendered, ...model.lines.slice(pos)];
          if (atEnd) model.final = !h.noEol;
          d += h.n.length;
        } else {
          const found = findTier(model.lines, h.o, strict);
          if (found === null) throw new Fail('no-match', op);
          const target = h.a - 1 + d;
          let best = found.occ[0]!;
          let bestDist = Math.abs(best - target);
          for (const p of found.occ) {
            const dist = Math.abs(p - target);
            if (dist < bestDist) {
              best = p;
              bestDist = dist;
            }
          }
          const rendered = renderN(model.lines, best, h.o, h.n, found.tier);
          const matchedToEnd = best + h.o.length === model.lines.length;
          model.lines = [...model.lines.slice(0, best), ...rendered, ...model.lines.slice(best + h.o.length)];
          if (matchedToEnd) model.final = !h.noEol;
          d += h.n.length - h.o.length;
        }
      }
      const out = joinFile(model);
      if (isMove) {
        tree.now.set(np, out);
        tree.now.set(op, null);
        moves.push([op, np]);
      } else {
        tree.now.set(op, out);
      }
    };
  });
}

// ---------- SEARCH/REPLACE blocks (SPEC section 7) ----------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sIdx = i;
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevEnd = rep;
    const p = path;
    const o = [...oldLines];
    const n = [...newLines];
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (o.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, n.length === 0 ? '' : n.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const model = splitFile(before);
      const found = findTier(model.lines, o, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const nItems: NItem[] = n.map((t) => ({ text: t, ctx: null }));
      const rendered = renderN(model.lines, pos, o, nItems, found.tier);
      model.lines = [...model.lines.slice(0, pos), ...rendered, ...model.lines.slice(pos + o.length)];
      tree.now.set(p, joinFile(model));
    });
    i = rep + 1;
  }
  return edits;
}

// ---------- V4A patches (SPEC section 8) ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let endIdx = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      endIdx = k;
      break;
    }
  }
  if (endIdx < 0 || lines[endIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < endIdx) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice(14).trim();
      i++;
      const addLines: string[] = [];
      let pending = -1;
      while (i < endIdx) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) {
          if (pending >= 0) throw new Exit2(`error: parse ${pending + 1}`);
          addLines.push(l.slice(1));
          i++;
          continue;
        }
        if (l === '') {
          if (pending >= 0) throw new Exit2(`error: parse ${pending + 1}`);
          addLines.push('');
          i++;
          continue;
        }
        if (blank(l)) {
          if (pending < 0) pending = i;
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (addLines.length > 0 && addLines[addLines.length - 1] === '') addLines.pop();
      const content = addLines.length === 0 ? '' : addLines.join('\n') + '\n';
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content);
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice(17).trim();
      i++;
      while (i < endIdx) {
        const l = lines[i]!;
        if (blank(l)) {
          i++;
          continue;
        }
        if (isSectionStart(l)) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice(17).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      if (i < endIdx && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice(13).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let closedByEof = false;
      while (i < endIdx) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('@@')) {
          curChunk = { anchor: l.slice(2).trim(), eof: false, body: [] };
          chunks.push(curChunk);
          closedByEof = false;
          i++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
          curChunk.eof = true;
          closedByEof = true;
          i++;
          while (i < endIdx && blank(lines[i]!)) i++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (closedByEof) throw new Exit2(`error: parse ${i + 1}`);
          if (curChunk === null) {
            curChunk = { anchor: null, eof: false, body: [] };
            chunks.push(curChunk);
          }
          curChunk.body.push(bodyLine(l));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length > 0) {
        const last = chunks[chunks.length - 1]!;
        while (last.body.length > 0) {
          const b = last.body[last.body.length - 1]!;
          if (b.kind === ' ' && b.text.trim() === '') last.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      const mt = moveTo;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const model = splitFile(before);
        let cursor = 0;
        for (const ch of chunks) {
          const { o, n } = splitBody(ch.body);
          if (ch.anchor !== null && ch.anchor !== '') {
            let foundIdx = -1;
            for (const t of tiers(strict)) {
              for (let k = cursor; k < model.lines.length; k++) {
                if (normLine(model.lines[k]!, t) === normLine(ch.anchor, t)) {
                  foundIdx = k;
                  break;
                }
              }
              if (foundIdx >= 0) break;
            }
            if (foundIdx < 0) throw new Fail('no-match', p);
            cursor = foundIdx + 1;
          }
          if (o.length === 0) {
            let pos = ch.eof ? model.lines.length : cursor;
            if (pos > model.lines.length) pos = model.lines.length;
            if (pos < 0) pos = 0;
            const rendered = n.map((it) => it.text);
            model.lines = [...model.lines.slice(0, pos), ...rendered, ...model.lines.slice(pos)];
            cursor = pos + rendered.length;
          } else {
            let hit: { tier: number; pos: number } | null = null;
            for (const t of tiers(strict)) {
              const occ = occurrences(model.lines, o, t, cursor);
              const elig = ch.eof ? occ.filter((pp) => pp + o.length === model.lines.length) : occ;
              if (elig.length > 0) {
                hit = { tier: t, pos: elig[0]! };
                break;
              }
            }
            if (hit === null) throw new Fail('no-match', p);
            const rendered = renderN(model.lines, hit.pos, o, n, hit.tier);
            model.lines = [...model.lines.slice(0, hit.pos), ...rendered, ...model.lines.slice(hit.pos + o.length)];
            cursor = hit.pos + rendered.length;
          }
        }
        const out = joinFile(model);
        if (mt !== null) {
          tree.now.set(mt, out);
          tree.now.set(p, null);
          moves.push([p, mt]);
        } else {
          tree.now.set(p, out);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------- JSON edits (SPEC section 9, as in the starter) ----------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- Run (SPEC sections 1, 2 and 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const movePairs = moves.filter(
    ([o, n]) => tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null,
  );
  const moveOld = new Set(movePairs.map(([o]) => o));
  const moveNew = new Set(movePairs.map(([, n]) => n));
  const rows: { key: string; line: string }[] = [];
  const sortedPaths = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of sortedPaths) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveOld.has(p) || moveNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of movePairs) rows.push({ key: n, line: `R ${o} -> ${n}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of sortedPaths) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
