import { describe, it, expect } from "vitest";
import { hostDialect, shellInvocation, quote, quotePath, andThen, cd, setVar, unsetVar, repointVar, sourceEnvFile } from "../../src/main/shell-dialect.js";

describe("shell-dialect", () => {
  it("reads the dialect from the shell first, the platform second", () => {
    expect(hostDialect("/bin/zsh", "darwin")).toBe("posix");
    expect(hostDialect("/bin/bash", "win32")).toBe("posix");          // git-bash on Windows
    expect(hostDialect("C:\\…\\powershell.exe", "win32")).toBe("powershell");
    expect(hostDialect("", "win32")).toBe("powershell");
    expect(hostDialect("", "darwin")).toBe("posix");
  });

  // His report, 2026-09-25: PowerShell died on "The token '&&' is not a valid
  // statement separator in this version". Nothing we compose may emit one.
  it("never emits && for PowerShell, and still guards the cd", () => {
    const line = andThen([cd("C:\\Users\\tim", "powershell"), "claude --model x"], "powershell");
    expect(line).not.toContain("&&");
    expect(line).toContain("if ($?)");
    expect(andThen([cd("/Users/tim", "posix"), "claude"], "posix")).toContain("&&");
  });

  it("sources an env file without POSIX set -a / . on PowerShell", () => {
    const ps = sourceEnvFile("C:\\Users\\tim\\.glyphh\\loops\\claude\\env", "powershell");
    expect(ps).not.toMatch(/(^|\s)set [+-]a/);
    expect(ps).not.toMatch(/(^|\s)\.\s+"/);
    expect(ps).toContain("Get-Content");
    expect(sourceEnvFile("/x/env", "posix")).toBe('set -a; . "/x/env"; set +a;');
  });

  it("drops and re-points vars in each shell's own words", () => {
    expect(unsetVar("ANTHROPIC_API_KEY", "posix")).toContain("unset ANTHROPIC_API_KEY");
    expect(unsetVar("ANTHROPIC_API_KEY", "powershell")).toContain("Remove-Item Env:\\ANTHROPIC_API_KEY");
    expect(unsetVar("X", "powershell")).not.toContain("unset ");
    expect(repointVar("ANTHROPIC_BASE_URL", "GLYPHH_DIRECT_ANTHROPIC_BASE_URL", "powershell")).not.toContain("[ -n ");
  });

  it("assigns env vars as statements on PowerShell, inline on POSIX", () => {
    expect(setVar("GLYPHH_MCP_TOKEN", "abc", "powershell")).toBe("$env:GLYPHH_MCP_TOKEN = 'abc';");
    expect(setVar("GLYPHH_MCP_TOKEN", "abc", "posix")).toBe(' GLYPHH_MCP_TOKEN="abc"');
  });

  it("quotes so a value cannot break out", () => {
    expect(quote("it's", "powershell")).toBe("'it''s'");
    expect(quote("it's", "posix")).toBe("'it'\\''s'");
    // A Windows path's backslashes survive; PowerShell's own metachars are escaped.
    expect(quotePath("C:\\Users\\tim", "powershell")).toBe('"C:\\Users\\tim"');
    expect(quotePath("C:\\a$b`c", "powershell")).toBe('"C:\\a`$b``c"');
  });

  it("spawns PowerShell without a profile, so banners cannot poison the JSON stream", () => {
    const [sh, args] = shellInvocation("powershell");
    expect(sh).toBe("powershell.exe");
    expect(args).toContain("-NoProfile");
    expect(args[args.length - 1]).toBe("-Command");
    expect(shellInvocation("posix")[1]).toEqual(["-lc"]);
  });
});
