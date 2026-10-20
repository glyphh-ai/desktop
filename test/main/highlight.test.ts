import { describe, it, expect } from "vitest";
import { highlight, languageOf } from "../../src/renderer/highlight";

/** The text a block shows, tags stripped and entities read back: whatever the
 *  highlighter does, the person must see (and copy) exactly the source. */
const shown = (html: string): string =>
  html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const tokens = (html: string, cls: string): string[] =>
  [...html.matchAll(new RegExp(`<span class="tk-${cls}">([^<]*)</span>`, "g"))].map((m) => shown(m[1]!));

describe("highlight — Prism-style, our own theme tokens (his order, 2026-09-29)", () => {
  it("never changes the text: every language round-trips to its source", () => {
    const samples: Array<[string, string]> = [
      ["ts", 'const a: number = await f("x < y && z"); // <b>\nif (a / b > 2) return /a+b/g.test(s);'],
      ["bash", "$ npm run build && cd ~/app\nexport FOO=\"bar\" # set\ngit commit -m 'msg' --amend"],
      ["python", '@route("/")\ndef f(x) -> None:\n    """doc <tag>"""\n    return x & 1'],
      ["json", '{"a": 1, "b": [true, null], "c": "<x>"}'],
      ["html", '<div class="a" hidden>hi &amp; bye</div>'],
      ["sql", "SELECT * FROM t WHERE a < 3 -- note"],
      ["diff", "--- a\n+++ b\n@@ -1 +1 @@\n-old <x>\n+new & y"],
      ["rust", "fn main() { println!(\"{}\", 1 << 2); }"],
    ];
    for (const [lang, code] of samples) expect(shown(highlight(code, lang))).toBe(code);
  });

  it("escapes everything, so a snippet can never inject markup", () => {
    const out = highlight('<img src=x onerror="alert(1)">', "html");
    expect(out).not.toMatch(/<img/);
    expect(highlight("<script>alert(1)</script>", "nope")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("tells a regex from a division", () => {
    const out = highlight("if (a / b > 2) return /ab+c/g.test(s);", "ts");
    expect(tokens(out, "regex")).toEqual(["/ab+c/g"]);
    expect(tokens(out, "operator")).toContain("/");
  });

  it("reads the COMMAND in a shell line, after a prompt and after &&", () => {
    const out = highlight("$ npm run build && cd ~/app --verbose", "console");
    expect(tokens(out, "function")).toEqual(["npm", "cd"]);
    expect(tokens(out, "attr")).toEqual(["--verbose"]);
  });

  it("keys and values are different things in JSON", () => {
    const out = highlight('{"name": "glyphh"}', "json");
    expect(tokens(out, "property")).toEqual(['"name"']);
    expect(tokens(out, "string")).toEqual(['"glyphh"']);
  });

  it("a diff colours by line", () => {
    const out = highlight("-old\n+new\n context", "diff");
    expect(tokens(out, "deleted")).toEqual(["-old"]);
    expect(tokens(out, "inserted")).toEqual(["+new"]);
  });

  it("knows the aliases people actually type, and nothing it cannot colour", () => {
    expect(languageOf("TSX")).toBe("ts");
    expect(languageOf("zsh")).toBe("sh");
    expect(languageOf("yml")).toBe("yaml");
    expect(languageOf("c++")).toBe("c");
    expect(languageOf("brainfuck")).toBeNull();
    expect(languageOf("")).toBeNull();
  });

  it("a very large block comes back plain rather than slow", () => {
    const big = "const x = 1;\n".repeat(20_000);
    const t = Date.now();
    const out = highlight(big, "ts");
    expect(Date.now() - t).toBeLessThan(500);
    expect(out).not.toContain("tk-keyword");
  });
});
