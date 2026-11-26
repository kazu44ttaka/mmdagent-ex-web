/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Plugin_VIManager/VIManager.cpp
 *   Plugin_VIManager/VIManager_Thread.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 *   Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
 *   (MMDAgent Project Team; BSD 3-Clause, see LICENSES/MMDAgent-BSD-3-Clause.txt)
 */

/**
 * MMDAgent-EX FST (finite state transducer) scripts, as Plugin_VIManager runs them.
 *
 * Written from the behaviour of Plugin_VIManager/VIManager.cpp in MMDAgent-EX:
 *   - block form ("0 LOOP:" followed by indented "input output [actions]" lines,
 *     chained through hidden intermediate states) and one-line arcs,
 *   - "+" lines that add an alternative input to the previous line,
 *   - "$var=value" lines at the top, `$var` / `${var}` / `$%KeyValue` in arcs,
 *     "$a==b" / "$a!=b" tests, "@regexp@" inputs with $1.. captures,
 *   - %INCLUDE("other.fst"), "<eps>" moves, arguments split by "|" then ",".
 * An FST and its sub FSTs ("main.fst" + "main.fst*.fst") run side by side.
 */

export const EPSILON = '<eps>';
const INITIAL_STATE = '0';
const MAX_EPSILON_STEPS = 10000;

/**
 * Split off one token, like getTokenFromStringWithQuoters: skip leading
 * separators, read until a separator outside quotes, skip trailing separators.
 * @param {string} str
 * @param {{ i: number }} pos
 * @param {string} separators
 * @param {string | null} quoters
 * @param {boolean} eraseQuote
 */
function nextToken(str, pos, separators, quoters, eraseQuote) {
  let out = '';
  while (pos.i < str.length && separators.includes(str[pos.i])) pos.i += 1;
  let inQuote = false;
  let quote = '';
  while (pos.i < str.length && (inQuote || !separators.includes(str[pos.i]))) {
    const c = str[pos.i];
    if (quoters && quoters.includes(c) && !(inQuote && c !== quote)) {
      if (inQuote) inQuote = false;
      else {
        inQuote = true;
        quote = c;
      }
      if (!eraseQuote) out += c;
      pos.i += 1;
      continue;
    }
    out += c;
    pos.i += 1;
  }
  while (pos.i < str.length && separators.includes(str[pos.i])) pos.i += 1;
  return out;
}

/** @param {string} line */
function fieldTokens(line) {
  const pos = { i: 0 };
  const is = nextToken(line, pos, ' \t', '"\'', true);
  const os = nextToken(line, pos, ' \t', '"\'', true);
  const vs = nextToken(line, pos, ' \t', '"\'', false);
  const er = nextToken(line, pos, ' \t', '"\'', true);
  return { is, os, vs, er };
}

/**
 * Event / command arguments: "a|b,c" → [["a"], ["b", "c"]].
 * @param {string} str
 * @returns {string[][]}
 */
export function parseArgs(str) {
  if (!str) return [];
  return String(str).split('|').map((a) => a.split(','));
}

/**
 * Split "TYPE|args" at the first "|".
 * @param {string} symbol
 * @returns {[string, string]}
 */
export function splitMessage(symbol) {
  const s = String(symbol ?? '');
  const i = s.indexOf('|');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

/**
 * @typedef {{ label: string, arcs: Arc[] }} State
 * @typedef {{
 *   itype: string, iargs: string[][], otype: string, oargs: string,
 *   action: string, next: State, block: number, line: number, file: string,
 * }} Arc
 * @typedef {{ get: (key: string) => string | undefined, set: (key: string, value: string) => void }} KeyValueLike
 */

export class Fst {
  /**
   * @param {{ keyValue?: KeyValueLike, log?: (msg: string) => void, name?: string }} [opts]
   */
  constructor(opts = {}) {
    this.keyValue = opts.keyValue || null;
    this.log = opts.log || (() => {});
    this.name = opts.name || 'main';
    /** @type {Map<string, State>} */
    this.states = new Map();
    /** @type {Map<string, string>} */
    this.vars = new Map();
    /** @type {State | null} */
    this.current = null;
    this.blockId = 0;
    this.appendNum = 0;
    this.ended = false;
  }

  /** @param {string} label */
  state(label) {
    let s = this.states.get(label);
    if (!s) {
      s = { label, arcs: [] };
      this.states.set(label, s);
    }
    return s;
  }

  /**
   * @param {State} from
   * @param {State} to
   * @param {string} isym
   * @param {string} osym
   * @param {string} vsym
   * @param {number} line
   * @param {string} file
   */
  addArc(from, to, isym, osym, vsym, line, file) {
    // a regular expression or a variable test keeps its "|"s (VIManager_SList_addArc)
    const whole = isym.length > 1 && ((isym.startsWith('@') && isym.endsWith('@')) || isym.startsWith('$'));
    const [itype, iargStr] = whole ? [isym, ''] : splitMessage(isym);
    const [otype, oargs] = splitMessage(osym);
    /** @type {Arc} */
    const arc = {
      itype, iargs: parseArgs(iargStr), otype, oargs,
      action: vsym || '', next: to, block: this.blockId, line, file,
    };
    from.arcs.push(arc);
    return arc;
  }

  /**
   * Load FST text. `include(path)` returns the text of an %INCLUDE'd file
   * (or null), resolved by the caller.
   * @param {string} text
   * @param {{ file?: string, include?: (path: string) => string | null, depth?: number }} [opts]
   */
  load(text, opts = {}) {
    const file = opts.file || this.name;
    const depth = opts.depth || 0;
    let top = true;
    let withinBlock = false;
    /** @type {Arc | null} */
    let arc = null;
    /** @type {State | null} */
    let last = null;
    let lastOs = '';
    let label1 = '';
    let label2 = '';
    let errors = 0;

    const lines = String(text || '').split('\n');
    for (let n = 0; n < lines.length; n += 1) {
      const lineNo = n + 1;
      const buff = lines[n].replace(/[\r\n]+$/, '');
      let idx = 0;
      while (idx < buff.length && (buff[idx] === ' ' || buff[idx] === '\t')) idx += 1;
      if (idx >= buff.length) {
        arc = null;
        withinBlock = false;
        continue;
      }
      const head = buff[idx];
      if (head === '$' && top) {
        if (!this.assign(buff.slice(idx))) this.log(`${file}:${lineNo}: failed to set variable`);
        arc = null;
        withinBlock = false;
        continue;
      }
      if (head === '%') {
        if (buff.startsWith('%INCLUDE', idx)) {
          const pos = { i: idx + 8 };
          const inc = nextToken(buff, pos, '() \t', '"\'', true);
          const sub = inc && opts.include ? opts.include(inc) : null;
          if (sub == null) {
            this.log(`${file}:${lineNo}: cannot include "${inc}"`);
            errors += 1;
          } else {
            errors += this.load(sub, { file: inc, include: opts.include, depth: depth + 1 }).errors;
          }
          arc = null;
          withinBlock = false;
          last = null;
        }
        continue;
      }
      if (head === '#') continue;
      top = false;

      if (idx === 0) {
        this.blockId += 1;
        const pos = { i: 0 };
        const s1 = nextToken(buff, pos, ' \t', '"\'', true);
        const s2 = nextToken(buff, pos, ' \t', '"\'', true);
        const rest = fieldTokens(buff.slice(pos.i));
        if (s1 && s2 && !rest.is) {
          if (!s2.endsWith(':')) {
            this.log(`${file}:${lineNo}: number line has no colon`);
            errors += 1;
          } else {
            label1 = s1;
            label2 = s2.slice(0, -1);
          }
          arc = null;
          withinBlock = true;
          last = null;
        } else if (s1 && s2 && rest.is && rest.os && !rest.er) {
          arc = this.addArc(this.state(s1), this.state(s2), rest.is, rest.os, rest.vs, lineNo, file);
          last = this.state(s1);
          lastOs = rest.os;
          withinBlock = false;
        } else {
          this.log(`${file}:${lineNo}: wrong format`);
          errors += 1;
          arc = null;
          withinBlock = false;
        }
        continue;
      }

      if (!withinBlock) {
        this.log(`${file}:${lineNo}: not in a block definition`);
        errors += 1;
        continue;
      }
      const t = fieldTokens(buff.slice(idx));
      if (t.is.startsWith('+')) {
        if (!arc || !last) {
          this.log(`${file}:${lineNo}: '+' should not be at the top of block`);
          errors += 1;
          continue;
        }
        if (t.is.length > 1 && !t.er) {
          arc = this.addArc(last, this.state(label2), t.is.slice(1), t.os || lastOs, t.vs, lineNo, file);
        }
        continue;
      }
      if (!(t.is && t.os && !t.er)) {
        if (!arc) {
          this.log(`${file}:${lineNo}: wrong format`);
          errors += 1;
        }
        continue;
      }
      if (!arc) {
        arc = this.addArc(this.state(label1), this.state(label2), t.is, t.os, t.vs, lineNo, file);
        last = this.state(label1);
      } else {
        // a hidden state between the previous line and this one
        const mid = this.state(`\u0000${String(this.appendNum).padStart(9, '0')}`);
        this.appendNum += 1;
        const to = this.state(label2);
        for (const a of /** @type {State} */ (last).arcs) {
          if (a.next === to && a.block === this.blockId) a.next = mid;
        }
        arc = this.addArc(mid, to, t.is, t.os, t.vs, lineNo, file);
        last = mid;
      }
      lastOs = t.os;
    }

    if (depth === 0) {
      this.current = this.states.get(INITIAL_STATE) || null;
      this.ended = false;
    }
    return { errors };
  }

  /**
   * Substitute $name, ${name}, $$ and $%KeyValue in a string.
   * @param {string} input
   */
  substitute(input) {
    const s = String(input ?? '');
    let out = '';
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c !== '$') {
        out += c;
        i += 1;
        continue;
      }
      i += 1;
      if (s[i] === '$') {
        out += '$';
        i += 1;
        continue;
      }
      let name = '';
      if (s[i] === '{') {
        let depth = 1;
        i += 1;
        while (i < s.length) {
          if (s[i] === '{') depth += 1;
          else if (s[i] === '}') {
            depth -= 1;
            if (depth === 0) {
              i += 1;
              break;
            }
          }
          name += s[i];
          i += 1;
        }
      } else {
        while (i < s.length && /[A-Za-z0-9_%]/.test(s[i])) {
          name += s[i];
          i += 1;
        }
      }
      if (name.includes('%ENV')) continue;
      if (name.startsWith('%')) {
        const v = this.keyValue?.get(name.slice(1));
        if (v != null) out += v;
        continue;
      }
      const v = this.vars.get(name);
      if (v != null) out += v;
    }
    return out;
  }

  /**
   * "$a=1,$b=2" (quotes allowed). `$%key=value` writes the KeyValue store.
   * @param {string} action
   */
  assign(action) {
    if (!action) return true;
    const pos = { i: 0 };
    let tok;
    while ((tok = nextToken(action, pos, ',', '"\'', true))) {
      const parts = tok.split('=');
      if (parts.length !== 2) return false;
      let name = parts[0].trim();
      if (!name.startsWith('$')) return false;
      name = name.slice(1);
      if (name.startsWith('{')) {
        if (!name.endsWith('}')) return false;
        name = name.slice(1, -1);
      }
      const value = this.substitute(parts[1]);
      if (name.startsWith('%')) this.keyValue?.set(name.slice(1), value);
      else this.vars.set(name, value);
    }
    return true;
  }

  /** "$a==b" / "$a!=b" after substitution. @param {string} expr */
  test(expr) {
    const s = this.substitute(expr);
    for (let i = 0; i < s.length - 1; i += 1) {
      if (s[i] === '!' && s[i + 1] === '=') return s.slice(0, i) !== s.slice(i + 2);
      if (s[i] === '=' && s[i + 1] === '=') return s.slice(0, i) === s.slice(i + 2);
    }
    return false;
  }

  /**
   * @param {Arc} arc
   * @param {string} itype
   * @param {string[][] | null} iargs
   * @param {string} iargStr
   */
  matches(arc, itype, iargs, iargStr) {
    const t = arc.itype;
    if (t.length > 1 && t.startsWith('@') && t.endsWith('@')) {
      const pattern = this.substitute(t.slice(1, -1));
      const target = iargs ? `${itype}|${iargStr}` : itype;
      let re;
      try {
        re = new RegExp(`^(?:${pattern})$`, 'u');
      } catch (_) {
        return target === pattern;
      }
      const m = re.exec(target);
      if (!m) return false;
      for (let k = 1; k < m.length; k += 1) this.vars.set(String(k), m[k] ?? '');
      return true;
    }
    if (t.length > 1 && t.startsWith('$')) return this.test(t);
    if (this.substitute(t) !== itype) return false;
    if (!iargs) return arc.iargs.length === 0;
    if (arc.iargs.length !== iargs.length) return false;
    for (let a = 0; a < arc.iargs.length; a += 1) {
      for (const want of arc.iargs[a]) {
        const w = this.substitute(want);
        if (!iargs[a].some((got) => got === w)) return false;
      }
    }
    return true;
  }

  /**
   * Try one transition. Returns the output message, or null if no arc matched.
   * @param {string} itype
   * @param {string} [iargStr] omitted for <eps>
   * @returns {{ type: string, args: string } | null}
   */
  transition(itype, iargStr) {
    const state = this.current;
    if (!state) return null;
    if (state.arcs.length === 0) {
      this.ended = true;
      return null;
    }
    const iargs = itype === EPSILON && iargStr === undefined ? null : parseArgs(iargStr || '');
    for (const arc of state.arcs) {
      if (!this.matches(arc, itype, iargs, iargStr || '')) continue;
      const out = { type: this.substitute(arc.otype), args: this.substitute(arc.oargs) };
      this.assign(arc.action);
      this.current = arc.next;
      return out;
    }
    return null;
  }

  /**
   * Feed an input (or <eps> when `itype` is omitted), then follow <eps> moves.
   * @param {string} [itype]
   * @param {string} [iargs]
   * @returns {Array<{ type: string, args: string }>} non-<eps> outputs in order
   */
  step(itype, iargs) {
    /** @type {Array<{ type: string, args: string }>} */
    const out = [];
    if (itype !== undefined && itype !== EPSILON) {
      const r = this.transition(itype, iargs ?? '');
      if (r && r.type !== EPSILON) out.push(r);
    }
    for (let n = 0; n < MAX_EPSILON_STEPS; n += 1) {
      const r = this.transition(EPSILON);
      if (!r) return out;
      if (r.type !== EPSILON) out.push(r);
    }
    this.log(`[${this.name}] stopped after ${MAX_EPSILON_STEPS} <eps> moves (loop?)`);
    return out;
  }
}

/**
 * A main FST plus its sub FSTs, fed with every message.
 */
export class FstSet {
  constructor() {
    /** @type {Fst[]} */
    this.fsts = [];
  }

  /** @param {Fst} fst */
  add(fst) {
    this.fsts.push(fst);
  }

  /** First <eps> moves of every FST. */
  start() {
    return this.fsts.flatMap((f) => f.step());
  }

  /**
   * @param {string} type
   * @param {string} args
   */
  input(type, args) {
    return this.fsts.flatMap((f) => f.step(type, args));
  }
}
