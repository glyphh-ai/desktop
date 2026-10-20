/**
 * shell-dialect — ONE place that knows whether a composed command line will be
 * read by a POSIX shell or by PowerShell.
 *
 * His report, 2026-09-25 (Windows): the loop's open line arrived at
 * PowerShell verbatim —
 *
 *   set -a; . "C:\Users\…\loops\claude\env"; set +a; cd "C:\Users\…" && claude …
 *
 * — and died on `The token '&&' is not a valid statement separator in this
 * version`. Every piece of that line is POSIX: `set -a` (export everything
 * that follows), `.` (source a file), `&&` (run-if-succeeded), `unset`,
 * `export`, `$VAR`. PowerShell 5.1 shares none of them, and the parse error
 * lands before the CLI is ever reached, so on Windows the terminal hop was
 * dead for every loop that had an env file — which, since the gateway writes
 * one, is every configured loop.
 *
 * The fix is not to escape harder. It is to stop assuming one dialect: the
 * composer asks for a JOIN, a CD, a SOURCE, an UNSET, and this module renders
 * each in the dialect the target shell actually speaks. Pure and injectable
 * (`dialectFor`) so the composition tests can prove both shells from macOS.
 */
import os from "os";

export type Dialect = "posix" | "powershell";

/** The dialect of the shell this machine's terminals and spawns will use.
 *  A Windows box with a POSIX $SHELL (git-bash, WSL interop) is honored —
 *  the platform is the fallback, not the verdict. */
export function hostDialect(shell?: string, platform?: string): Dialect {
  const sh = String(shell ?? process.env.SHELL ?? "");
  if (/(^|[\\/])(bash|zsh|sh|fish|dash|ksh)(\.exe)?$/i.test(sh)) return "posix";
  if (/(^|[\\/])(powershell|pwsh|cmd)(\.exe)?$/i.test(sh)) return "powershell";
  return (platform ?? os.platform()) === "win32" ? "powershell" : "posix";
}

/** The shell + args to spawn for a one-shot command line in this dialect.
 *  PowerShell needs -NoProfile so a user's profile cannot print banners into
 *  the JSON stream the bridge parses. */
export function shellInvocation(d: Dialect): [string, string[]] {
  return d === "powershell"
    ? ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]]
    : [process.env.SHELL || "/bin/zsh", ["-lc"]];
}

/** A value as a literal the shell will not re-interpret. PowerShell's single
 *  quote is fully literal and doubles to escape itself; POSIX's is the same
 *  except it cannot contain its own quote, hence the classic '\'' dance. */
export function quote(v: string, d: Dialect): string {
  const s = String(v ?? "");
  return d === "powershell" ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, "'\\''")}'`;
}

/** A path as an argument. Double quotes on both, but PowerShell treats a
 *  backtick as its escape and `$` as interpolation inside them. */
export function quotePath(p: string, d: Dialect): string {
  const s = String(p ?? "");
  return d === "powershell"
    ? `"${s.replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, '`"')}"`
    : `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Run the next command only if the previous one succeeded.
 *  `&&` is a parse error in PowerShell 5.1 (the shell Windows ships), and
 *  even in 7+ it is not the idiom here — a failed `cd` must not run the CLI
 *  in the wrong folder, which is exactly what `;` would do. */
export function andThen(parts: string[], d: Dialect): string {
  const kept = parts.filter((p) => p && p.trim());
  if (kept.length <= 1) return kept[0] ?? "";
  return d === "powershell" ? kept.join("; if ($?) { ") + " }".repeat(kept.length - 1) : kept.join(" && ");
}

/** Run a program by its full path with arguments. PowerShell reads a quoted
 *  path as a string expression, not a command, unless `&` calls it. */
export function invoke(exe: string, args: string[], d: Dialect): string {
  const line = [exe, ...args].map((a) => quotePath(a, d)).join(" ");
  return d === "powershell" ? `& ${line}` : line;
}

/** Change directory. */
export function cd(dir: string, d: Dialect): string {
  return d === "powershell" ? `Set-Location -LiteralPath ${quotePath(dir, d)}` : `cd ${quotePath(dir, d)}`;
}

/** Set one environment variable for the rest of this line. */
export function setVar(name: string, value: string, d: Dialect): string {
  return d === "powershell" ? `$env:${name} = ${quote(value, d)};` : ` ${name}=${quotePath(value, d)}`;
}

/** Drop a variable, so a turn that stays off the gateway does not inherit it. */
export function unsetVar(name: string, d: Dialect): string {
  return d === "powershell"
    ? ` Remove-Item Env:\\${name} -ErrorAction SilentlyContinue;`
    : ` unset ${name};`;
}

/** Point a var at another var's value, dropping it when that value is empty.
 *  (The gateway's base URL is re-pointed at the bridge, never merely removed.) */
export function repointVar(name: string, from: string, d: Dialect): string {
  return d === "powershell"
    ? ` $env:${name} = [Environment]::GetEnvironmentVariable('${from}'); if (-not $env:${name}) { Remove-Item Env:\\${name} -ErrorAction SilentlyContinue };`
    : ` export ${name}="\${${from}:-}"; [ -n "$${name}" ] || unset ${name};`;
}

/**
 * Source a KEY="value" env file so every name in it is exported for the rest
 * of the line. POSIX has one idiom for this (`set -a; . file; set +a`);
 * PowerShell has none, so we parse the file's own format inline — the same
 * format writeEnvValue emits, quotes and all. The file's path is the only
 * thing that ever appears on screen; values stay invisible in both dialects.
 */
export function sourceEnvFile(file: string, d: Dialect): string {
  if (d !== "powershell") return `set -a; . ${quotePath(file, d)}; set +a;`;
  return `Get-Content -LiteralPath ${quotePath(file, d)} | ForEach-Object { if ($_ -match '^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*"?(.*?)"?\\s*$') { Set-Item -Path ("Env:" + $Matches[1]) -Value $Matches[2] } };`;
}
