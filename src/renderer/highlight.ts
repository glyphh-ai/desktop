/**
 * highlight.ts — SYNTAX HIGHLIGHTING for every code block the app renders (his
 * order, 2026-09-29: "code highlighting, inline copy / paste icons (all very
 * much theme aligned per selected theme)"; his pick: "Prism-style, our own
 * theme tokens").
 *
 * Prism's model, our own grammars: each language is an ordered list of sticky
 * regexes, the first rule to match at a position wins, and a match becomes a
 * `<span class="tk-…">`. The COLOURS are not here at all — `.tk-*` in
 * styles.css maps each token class onto the theme's own semantic variables
 * (--accent-text, --success, --warning, --blue…), which every theme already
 * defines, so a block reads as part of whichever theme is on.
 *
 * Input is RAW source; everything is escaped on the way out. Anything past the
 * size cap, or in a language with no grammar, is returned escaped and plain —
 * a highlighter must never be the reason a transcript is slow.
 */

interface Rule {
  /** Token class, or "" for text that is consumed but not coloured (a whole
   *  identifier, so the scanner does not re-try every rule mid-word). */
  cls: string;
  re: RegExp;
}
type Grammar = readonly Rule[];

const MAX_CHARS = 120_000;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const r = (cls: string, re: RegExp): Rule => ({ cls, re: new RegExp(re.source, re.flags.includes("y") ? re.flags : `${re.flags}y`) });
const words = (list: string, flags = ""): RegExp => new RegExp(`\\b(?:${list.trim().split(/\s+/).join("|")})\\b`, flags);

// ── shared pieces ────────────────────────────────────────────────────────────

const DQ = /"(?:\\[\s\S]|[^"\\\n])*"?/;
const SQ = /'(?:\\[\s\S]|[^'\\\n])*'?/;
const BT = /`(?:\\[\s\S]|[^`\\])*`?/;
const NUM = /\b(?:0x[\da-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]*\b/;
const IDENT = /[A-Za-z_$][\w$]*/;
const OPS = /[-+*/%=&|^!<>?:~]+/;
const PUNCT = /[{}[\]();,.]/;

/** The C family: JS/TS, Java, Go, Rust, C/C++, C#, Kotlin, Swift, PHP. */
function cLike(keywords: string, extra: Rule[] = []): Grammar {
  return [
    r("comment", /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/),
    ...extra,
    r("string", DQ), r("string", SQ), r("string", BT),
    r("number", NUM),
    r("keyword", words(keywords)),
    r("builtin", words("true false null undefined nil this self super NaN Infinity")),
    r("type", /\b[A-Z][A-Za-z0-9_]*\b/),
    r("function", /[A-Za-z_$][\w$]*(?=\s*\()/),
    r("", IDENT),
    r("operator", OPS),
    r("punct", PUNCT),
  ];
}

const JS_KW = `
  const let var function return if else for while do switch case default break continue new delete typeof instanceof
  in of class extends implements interface type enum namespace declare abstract public private protected readonly static
  import export from as async await yield try catch finally throw void keyof satisfies infer is get set`;

const JS = cLike(JS_KW, [
  r("regex", /\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuyv]*(?=\s*(?:[.,;)\]}]|$))/m),
  // TypeScript's primitive types read as types, not as plain words.
  r("type", words("string number boolean any unknown never object bigint symbol")),
]);

const PY: Grammar = [
  r("comment", /#[^\n]*/),
  r("string", /[rbfuRBFU]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$))/),
  r("string", new RegExp(`[rbfuRBFU]{0,2}(?:${DQ.source}|${SQ.source})`)),
  r("function", /@[\w.]+/),
  r("number", NUM),
  r("keyword", words(`
    def class return if elif else for while in not and or is lambda import from as with try except finally raise
    pass break continue yield async await global nonlocal assert del match case`)),
  r("builtin", words("True False None self cls print len range dict list set tuple str int float bool open super isinstance")),
  r("type", /\b[A-Z][A-Za-z0-9_]*\b/),
  r("function", /[A-Za-z_]\w*(?=\s*\()/),
  r("", /[A-Za-z_]\w*/),
  r("operator", OPS),
  r("punct", PUNCT),
];

/** Shell: the FIRST word of a command is what a person reads, so it is the
 *  function colour — at a line start and after | && || ; ( and `$ ` prompts. */
const SH: Grammar = [
  r("comment", /(?<=^|\s)#[^\n]*/m),
  r("punct", /^\s*[$%>]\s(?=\S)/m),
  r("string", DQ), r("string", SQ),
  r("variable", /\$(?:\{[^}\n]*\}?|[A-Za-z_]\w*|[@*#?$!0-9-])/),
  r("keyword", words("if then else elif fi for in do done while until case esac function select time return export local readonly unset")),
  r("function", /(?<=^|[|;&(]\s*|&&\s*|\|\|\s*|^\s*[$%>]\s)[A-Za-z_./~][\w./~@+-]*/m),
  r("attr", /(?<=\s)--?[A-Za-z][\w-]*/),
  r("number", /\b\d+\b/),
  r("", /[A-Za-z_][\w.-]*/),
  r("operator", /&&|\|\||[|&;<>]+|=/),
  r("punct", /[{}[\]()]/),
];

const JSONG: Grammar = [
  r("comment", /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/),
  r("property", new RegExp(`${DQ.source}(?=\\s*:)`)),
  r("string", DQ),
  r("number", /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/),
  r("builtin", words("true false null")),
  r("punct", /[{}[\],:]/),
];

const CSS: Grammar = [
  r("comment", /\/\*[\s\S]*?(?:\*\/|$)/),
  r("keyword", /@[\w-]+/),
  r("string", DQ), r("string", SQ),
  r("property", /[\w-]+(?=\s*:(?!:))/),
  r("number", /#[\da-fA-F]{3,8}\b|-?\b\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex)?\b/),
  r("function", /[\w-]+(?=\()/),
  r("type", /[.#][\w-]+|::?[\w-]+/),
  r("", /[\w-]+/),
  r("punct", /[{}();,:>+~*]/),
];

const HTML: Grammar = [
  r("comment", /<!--[\s\S]*?(?:-->|$)/),
  r("keyword", /<!DOCTYPE[^>]*>/i),
  r("tag", /<\/?[A-Za-z][\w:.-]*|\/?>/),
  r("attr", /(?<=\s)[A-Za-z_:@][\w:.-]*(?=\s*=)|(?<=\s)[A-Za-z_:@][\w:.-]*(?=[\s/>])/),
  r("string", /"[^"]*"?|'[^']*'?/),
  r("builtin", /&[#\w]+;/),
  r("operator", /=/),
];

const YAML: Grammar = [
  r("comment", /#[^\n]*/),
  r("property", /^[ \t-]*[\w.-]+(?=\s*:(?:\s|$))/m),
  r("string", DQ), r("string", SQ),
  r("builtin", words("true false yes no null on off")),
  r("number", /(?<=[\s:[,-])-?\d+(?:\.\d+)?\b/),
  r("keyword", /[&*][\w-]+|!![\w]+|^---$|^\.\.\.$/m),
  r("punct", /[{}[\],:|>-]/),
];

const TOML: Grammar = [
  r("comment", /[#;][^\n]*/),
  r("type", /^\s*\[\[?[^\]\n]*\]\]?/m),
  r("property", /^\s*[\w."-]+(?=\s*=)/m),
  r("string", /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)/), r("string", DQ), r("string", SQ),
  r("builtin", words("true false")),
  r("number", /-?\b\d[\d_]*(?:\.\d+)?\b/),
  r("punct", /[=[\],{}]/),
];

const SQL: Grammar = [
  r("comment", /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/),
  r("string", /'(?:''|[^'])*'?/), r("property", /"(?:""|[^"])*"?/),
  r("number", /\b\d+(?:\.\d+)?\b/),
  r("keyword", words(`
    select from where and or not in is null as join left right inner outer full cross on group by order having limit
    offset insert into values update set delete create table alter drop index view primary key foreign references
    unique default constraint distinct union all case when then else end exists between like ilike returning with
    begin commit rollback transaction grant revoke if cascade asc desc`, "i")),
  r("type", words("int integer bigint smallint text varchar char boolean bool jsonb json uuid timestamptz timestamp date numeric decimal real serial bytea", "i")),
  r("function", /[A-Za-z_]\w*(?=\s*\()/),
  r("", /[A-Za-z_]\w*/),
  r("operator", /[-+*/%=<>!|]+/),
  r("punct", /[();,.]/),
];

const RUBY: Grammar = [
  r("comment", /#[^\n]*/),
  r("string", DQ), r("string", SQ),
  r("variable", /[@$]{1,2}[A-Za-z_]\w*/),
  r("builtin", /:[A-Za-z_]\w*[?!]?/),
  r("number", NUM),
  r("keyword", words("def class module end if elsif else unless case when while until for in do return yield begin rescue ensure raise then self nil true false and or not require require_relative attr_accessor")),
  r("type", /\b[A-Z][A-Za-z0-9_]*\b/),
  r("function", /[A-Za-z_]\w*[?!]?(?=\s*\()/),
  r("", /[A-Za-z_]\w*[?!]?/),
  r("operator", OPS),
  r("punct", PUNCT),
];

const DOCKER: Grammar = [
  r("comment", /#[^\n]*/),
  r("keyword", /^\s*(?:FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|AS)\b/im),
  ...SH.filter((x) => x.cls !== "comment"),
];

const MARKDOWN: Grammar = [
  r("keyword", /^#{1,6}[^\n]*/m),
  r("string", /`[^`\n]*`/),
  r("builtin", /\*\*[^*\n]+\*\*|__[^_\n]+__/),
  r("attr", /\[[^\]\n]*\]\([^)\n]*\)/),
  r("punct", /^\s*(?:[-*+]|\d+\.)\s/m),
];

const LANGS: Record<string, Grammar> = {
  js: JS, ts: JS,
  json: JSONG,
  sh: SH,
  py: PY,
  css: CSS,
  html: HTML,
  yaml: YAML,
  toml: TOML,
  sql: SQL,
  ruby: RUBY,
  docker: DOCKER,
  md: MARKDOWN,
  go: cLike("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
  rust: cLike("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while Self", [r("function", /[a-z_]\w*!/)]),
  java: cLike("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized throw throws transient try void volatile while var record sealed permits yield"),
  c: cLike("auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected virtual override using new delete nullptr constexpr noexcept", [r("keyword", /#\s*\w+/)]),
  cs: cLike("abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch throw try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var async await record init"),
  kotlin: cLike("as break class continue do else for fun if in interface is object package return super throw try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where actual abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg"),
  swift: cLike("associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch is throw throws try async await some any"),
  php: cLike("abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include instanceof insteadof interface isset list match namespace new or print private protected public readonly require return static switch throw trait try unset use var while xor yield", [r("variable", /\$[A-Za-z_]\w*/), r("comment", /#[^\n]*/)]),
  diff: [],
};

const ALIASES: Record<string, string> = {
  javascript: "js", jsx: "js", mjs: "js", cjs: "js", typescript: "ts", tsx: "ts", mts: "ts", cts: "ts",
  jsonc: "json", json5: "json",
  bash: "sh", zsh: "sh", shell: "sh", console: "sh", terminal: "sh", fish: "sh", ksh: "sh",
  python: "py", python3: "py",
  scss: "css", less: "css", sass: "css",
  xml: "html", svg: "html", vue: "html", svelte: "html", htm: "html",
  yml: "yaml", ini: "toml", conf: "toml", properties: "toml",
  golang: "go", rs: "rust", kt: "kotlin", kts: "kotlin",
  h: "c", cpp: "c", "c++": "c", cc: "c", hpp: "c", cxx: "c", objc: "c",
  csharp: "cs", "c#": "cs", rb: "ruby", dockerfile: "docker",
  markdown: "md", patch: "diff", psql: "sql", postgres: "sql", mysql: "sql", sqlite: "sql",
};

/** The grammar key for a fence label, or null when we carry none. */
export function languageOf(lang: string): string | null {
  const k = lang.trim().toLowerCase();
  if (!k) return null;
  const key = ALIASES[k] ?? k;
  return key in LANGS ? key : null;
}

function tokenize(code: string, g: Grammar): string {
  let out = "";
  let plain = "";
  let i = 0;
  const flush = (): void => { if (plain) { out += esc(plain); plain = ""; } };
  scan: while (i < code.length) {
    for (const rule of g) {
      rule.re.lastIndex = i;
      const m = rule.re.exec(code);
      if (!m || !m[0]) continue;
      if (rule.cls) { flush(); out += `<span class="tk-${rule.cls}">${esc(m[0])}</span>`; }
      else plain += m[0];
      i += m[0].length;
      continue scan;
    }
    plain += code[i];
    i += 1;
  }
  flush();
  return out;
}

/** A diff reads by LINE: added, removed, hunk, file header. */
function diffLines(code: string): string {
  return code.split("\n").map((line) => {
    const cls = /^(?:\+\+\+|---)\s/.test(line) || /^(?:diff |index )/.test(line) ? "comment"
      : line.startsWith("@@") ? "keyword"
      : line.startsWith("+") ? "inserted"
      : line.startsWith("-") ? "deleted"
      : "";
    return cls ? `<span class="tk-${cls}">${esc(line)}</span>` : esc(line);
  }).join("\n");
}

/** Highlighted, escaped HTML for `code` in `lang`. Unknown languages and very
 *  large blocks come back escaped and uncoloured. */
export function highlight(code: string, lang: string): string {
  const key = languageOf(lang);
  if (!key || code.length > MAX_CHARS) return esc(code);
  if (key === "diff") return diffLines(code);
  try {
    return tokenize(code, LANGS[key]!);
  } catch {
    return esc(code);
  }
}
