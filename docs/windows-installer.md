# Windows installer: "Glyphh Desktop cannot be closed"

## What it actually means

The message is misleading. `$(appCannotBeClosed)` is emitted from **three**
different places in `app-builder-lib`'s NSIS templates, and only one of them
hangs. Identify which before changing anything.

| # | Template | Fires when | Behaviour on Retry |
|---|----------|-----------|--------------------|
| 1 | `allowOnlyOneInstallerInstance.nsh` → `_CHECK_APP_RUNNING` | the app really is running | re-checks; clears once the app exits |
| 2 | `extractAppPackage.nsh` → `extractUsing7za` | `CopyFiles` into `$INSTDIR` failed 5× (a file is locked) | **falls through** to a last-resort `Nsis7z::Extract` — always makes progress |
| 3 | `installUtil.nsh` → `uninstallOldVersion` | on **upgrade**, the previously installed version's uninstaller exits non-zero | **infinite loop** — see below |

Case 3 is the one that traps users:

```nsis
UninstallLoop:
  IntOp $R5 $R5 + 1
  ${if} $R5 > 5
    MessageBox MB_RETRYCANCEL ... "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY OneMoreAttempt
    Return
  ${endIf}
OneMoreAttempt:
  ExecWait '"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir' $R0
  CheckResult:
    ${if} $R0 == 0
      Return
    ${endIf}
  Sleep 1000
  Goto UninstallLoop          ; ← straight back to the prompt
```

Retry re-runs the *same failing uninstaller*, gets the same non-zero exit, and
returns to the prompt. It can never succeed.

## Telling them apart

Click **Show details** in the installer:

- `Can't modify "Glyphh Desktop"'s files.` → case **2** (a lock).
- `Waiting for "Glyphh Desktop" to close.` → case **1** (genuinely running).
- **Neither line** → case **3**. `uninstallOldVersion` prints nothing.

Corroborating signals for case 3:

- `taskkill /f /t /im "Glyphh Desktop.exe"` reports **"not found"** — nothing is
  running, so it is not a lock.
- The failure is byte-identical on every attempt. A file lock is intermittent;
  a failing uninstaller is deterministic.
- Retry never advances the progress bar.

## Fixed in 2.7.2

Installers ≥ 2.7.2 perform the recovery below **themselves**: `customInit`
deletes the previous version's Uninstall registry entry
(`_glyphhForgetOldUninstaller` in `assets/installer.nsh`), so
`uninstallOldVersion` reads an empty `UninstallString` and returns before its
first `ExecWait`. The old uninstaller — the one binary on the machine we can
never patch — simply never runs. A machine stuck in the loop today heals the
moment it runs any ≥ 2.7.2 installer (auto-update download or manual).

The same change removed `/t` from `_glyphhKill`: on the auto-update handoff
the installer and the old uninstaller are *children of the still-exiting old
app*, so a tree-kill rooted at the app's image name could kill them mid-run —
the uninstaller's non-zero exit being exactly what arms case 3. Plain `/im`
already matches every Electron process (they share the exe name).

## Manual recovery (pre-2.7.2 installers only)

Remove the stale installation *and* its Uninstall registry entry, so the new
installer never reaches `uninstallOldVersion`. In **PowerShell**:

```powershell
# 1. Nothing should be running (expect "not found")
taskkill /f /t /im "Glyphh Desktop.exe"

# 2. Remove the install directory (per-user install location)
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\Glyphh Desktop" -ErrorAction SilentlyContinue

# 3. Remove the Uninstall registry entries that point at it
foreach ($root in @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)) {
  Get-ChildItem $root -ErrorAction SilentlyContinue | Where-Object {
    (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DisplayName -like '*Glyphh*'
  } | ForEach-Object {
    Write-Host "removing $($_.PSPath)"
    Remove-Item $_.PSPath -Recurse -Force
  }
}
```

Then run the installer again. With no prior version registered, the upgrade
path is skipped entirely.

`Remove-Item` is the PowerShell command — `rmdir /s /q` is `cmd.exe` syntax and
fails in PowerShell with *"A positional parameter cannot be found that accepts
argument '/q'"*.

## Why the earlier fixes (2.2.2–2.2.6) did nothing

They all targeted cases 1 and 2 — `customInit`, `customCheckAppRunning`,
`customUnInit`, and a path-scoped process kill. Case 3 runs inside
`uninstallOldVersion`, which none of those hooks touch. Overriding the
running-app check cannot suppress a prompt raised by the old uninstaller
failing.

## Do not reintroduce

`_glyphhKill` must kill **by process name only**. A previous revision also ran:

```powershell
Get-Process | Where-Object { $_.Path -like '$INSTDIR\*' } | Stop-Process -Force
```

That macro is also inserted into the **uninstaller** (`customUnInit`), which on
the upgrade path runs against the install directory. Killing by path there can
terminate the uninstall run itself → non-zero exit → case 3, permanently.
