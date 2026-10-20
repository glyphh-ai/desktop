import { describe, it, expect } from "vitest";
import { formatMarkdown, streamStableCut } from "../../src/renderer/format-markdown";

describe("formatMarkdown — images, file links, and what must stay inert", () => {
  it("a quote in a link can never become an attribute (script in the app's renderer)", () => {
    const html = formatMarkdown('[x](https://a.test/" onmouseover="alert(1))');
    // A real attribute follows a CLOSING quote. Before the fix the output read
    // href="https://a.test/" onmouseover="alert(1" — a live handler.
    expect(html).not.toMatch(/"\s+onmouseover=/i);
    // The payload is still there, but as text inside the value.
    expect(html).toContain("&quot; onmouseover=&quot;");
  });

  it("a code span is literal, whatever markdown it shows", () => {
    const html = formatMarkdown("Use `[text](https://x.test)` and `![a](https://x.test/a.png)`.");
    expect(html).not.toMatch(/<a /);
    expect(html).not.toMatch(/<img /);
    expect(html).toContain("[text](https://x.test)");
  });

  it("renders an image the agent points at, and says where it came from", () => {
    const html = formatMarkdown("![the chart](https://cdn.test/chart.png)");
    expect(html).toContain('<img class="yo-md-img" src="https://cdn.test/chart.png" alt="the chart"');
    expect(html).toContain('<span class="yo-md-caption">the chart</span>');
  });

  it("a local image becomes a file:// source the app can load", () => {
    const html = formatMarkdown("![out](/Users/me/app data/out.png)");
    // A space in the path breaks the markdown; the escaped form is the one agents write.
    const ok = formatMarkdown("![out](/Users/me/out%20file.png)");
    expect(ok).toContain('src="file:///Users/me/out%2520file.png"');
    expect(html).not.toContain("<img");
  });

  it("an image source we cannot vouch for stays text", () => {
    const html = formatMarkdown("![x](javascript:alert(1))");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript');
  });

  it("a link to a file on this machine opens the file, never navigates", () => {
    const html = formatMarkdown("See [the report](/Users/me/report.md).");
    expect(html).toContain('class="yo-md-link yo-md-file"');
    expect(html).toContain('data-path="/Users/me/report.md"');
    expect(html).not.toContain('href="/Users');
  });

  it("a web link still opens as a panel, and a URL inside link text is not linked twice", () => {
    const html = formatMarkdown("[https://glyphh.ai](https://glyphh.ai) and https://docs.test/x");
    expect(html.match(/<a /g)?.length).toBe(2);
    expect(html).toContain('target="_blank"');
  });

  it("bold still works inside a link's text", () => {
    expect(formatMarkdown("[**big**](https://x.test)")).toContain("<strong>big</strong></a>");
  });

  it("a task list reads as one, done items visibly done", () => {
    const html = formatMarkdown("- [x] read the loop\n- [ ] run the tests");
    expect(html).toContain('class="yo-md-ul yo-md-tasks"');
    expect(html).toContain('<span class="yo-md-check on"');
    expect(html).toContain('<span class="yo-md-check"');
    expect(html).not.toContain("[x]");
  });

  it("a list keeps its numbers across a paragraph (and a streamed reply's parts)", () => {
    expect(formatMarkdown("3. third\n4. fourth")).toContain('<ol class="yo-md-ol" start="3">');
    expect(formatMarkdown("1. first")).toContain('<ol class="yo-md-ol">');
  });

  it("strikethrough, and a file reference in code that opens the file", () => {
    expect(formatMarkdown("~~gone~~")).toContain("<del>gone</del>");
    const html = formatMarkdown("See `src/main/glyphh-loop.ts:348` and `npm test`.");
    expect(html).toContain('data-path="src/main/glyphh-loop.ts"');
    // A command is not a file.
    expect(html).toContain('<code class="yo-md-inline">npm test</code>');
  });

  it("a streaming reply is cut only after finished blocks, never inside a fence", () => {
    const t = "Intro para.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n";
    // The blank line inside the open fence is not a cut: only the one before it.
    expect(streamStableCut(t)).toBe("Intro para.\n\n".length);
    const closed = `${t}\u0060\u0060\u0060\n\nTail being written`;
    expect(closed.slice(streamStableCut(closed))).toBe("Tail being written");
    expect(streamStableCut("no blank line yet")).toBe(0);
  });
});
