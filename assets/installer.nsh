; Custom NSIS include — wired in explicitly via electron-builder.yml
; (nsis.include: installer.nsh).
;
; ── About the "Glyphh Desktop cannot be closed" hang ────────────────────────
; That message string, $(appCannotBeClosed), is emitted from THREE different
; places in app-builder-lib's NSIS templates. Only one of them loops forever,
; and it is NOT the app-running check:
;
;   1. allowOnlyOneInstallerInstance.nsh → _CHECK_APP_RUNNING
;        The app-running check. Overridable via customCheckAppRunning (below).
;   2. extractAppPackage.nsh → extractUsing7za
;        CopyFiles into $INSTDIR failed 5x. Retry FALLS THROUGH to a
;        last-resort Nsis7z::Extract, so this path always makes progress.
;   3. installUtil.nsh → uninstallOldVersion          ← the one that hangs
;        On UPGRADE, the previously installed version's uninstaller is run
;        first. If it exits non-zero:
;            UninstallLoop: ... MessageBox ... IDRETRY OneMoreAttempt
;            OneMoreAttempt: ExecWait <old uninstaller>  → non-zero
;                            Sleep 1000 / Goto UninstallLoop
;        i.e. Retry re-runs the same failing uninstaller and comes straight
;        back to the prompt. It can never succeed — an infinite loop.
;
; Symptom check for (3): the app is NOT running (taskkill reports "not found"),
; the failure is identical on every attempt (a file lock would be
; intermittent), and Retry never advances. Recovery is to remove the stale
; installation + its Uninstall registry entry so uninstallOldVersion is never
; reached; see docs/windows-installer.md.
;
; As of 2.7.2 the installer performs that recovery ITSELF: customInit deletes
; the old Uninstall registry entry (_glyphhForgetOldUninstaller below), so
; uninstallOldVersion finds no UninstallString and Returns without ever
; running the old uninstaller. Case 3 is structurally unreachable — including
; on machines already stuck, the moment they run any installer ≥ 2.7.2.
;
; ── VC++ runtime ───────────────────────────────────────────────────────────
; kuzu's native module (kuzujs.node) links against the Microsoft Visual C++
; 2015–2022 x64 runtime. Without it the module fails to load with "The
; specified module could not be found" and graph memory stays disabled.
; vc_redist.x64.exe is fetched into <buildResources> by scripts/before-pack.cjs
; before packaging, so ${BUILD_RESOURCES_DIR}\vc_redist.x64.exe exists at
; makensis time. The redist is idempotent; we still skip it when the runtime is
; already registered, so most users see no extra step.

!include "LogicLib.nsh"

; Force-close any running instance. Electron runs several processes all named
; ${APP_EXECUTABLE_FILENAME} (main, GPU, renderer, utility) and Glyphh can stay
; resident in the tray; a plain /im kill matches every one of them by image
; name. Kill twice to absorb respawns.
;
; NOTE: deliberately by-name only, and deliberately WITHOUT /t. Two hard-won
; lessons live here:
;   - An earlier revision ran a PowerShell "stop every process whose image
;     path is under $INSTDIR" sweep — but this macro is also inserted into the
;     UNINSTALLER, which on the upgrade path runs with the install dir as its
;     target. Killing by path there terminated the uninstall run itself →
;     non-zero exit → the uninstallOldVersion loop above. Do not reintroduce.
;   - /t (tree-kill) has the same self-kill failure by a different route: on
;     the auto-update handoff the installer — and the old uninstaller it
;     ExecWaits — are CHILDREN of the still-exiting old app. /t walking down
;     from the app's name killed them mid-run; the uninstaller's non-zero exit
;     is again the uninstallOldVersion loop. Every Electron process already
;     matches by image name, so /t bought nothing. Do not reintroduce.
!macro _glyphhKill
  DetailPrint "Glyphh: clearing any running instances..."
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 800
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 400
!macroend

; Bypass uninstallOldVersion entirely (call site 3 — the infinite loop).
; installSection.nsh only enters the loop when the Uninstall registry entry's
; UninstallString is non-empty; with the entry gone it Returns before the
; first ExecWait. We never run the OLD version's uninstaller — it is the one
; binary on the machine we cannot patch, and one non-zero exit from it traps
; the user forever (2.2.6's self-killing uninstaller, tree-kill casualties,
; AV interference — all landed here). The new install extracts over the same
; per-user $INSTDIR and re-registers shortcuts and the uninstall entry, so
; skipping the old cleanup costs at most a few stale files.
; Both registry views: same-arch installers wrote under 64, but belt+braces.
; The HKLM delete is best-effort — a per-user install runs unelevated and a
; leftover per-machine entry stays; that's the pre-existing edge, not a new one.
!macro _glyphhForgetOldUninstaller
  DetailPrint "Glyphh: releasing the previous version's uninstaller..."
  SetRegView 64
  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY_2}"
    DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  SetRegView 32
  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY_2}"
    DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  SetRegView 64
!macroend

!macro customInit
  !insertmacro _glyphhKill
  !insertmacro _glyphhForgetOldUninstaller
!macroend

; Defining customCheckAppRunning REPLACES electron-builder's built-in
; running-app check (call site 1 above) in both installer and uninstaller, so
; its prompt never runs.
!macro customCheckAppRunning
  !insertmacro _glyphhKill
!macroend

!macro customUnInit
  !insertmacro _glyphhKill
!macroend

!macro customInstall
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64" "Installed"
  ${If} $0 != 1
    DetailPrint "Installing the Microsoft Visual C++ runtime (required by graph memory)…"
    SetOutPath "$PLUGINSDIR"
    File "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
    ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $1
    DetailPrint "Visual C++ runtime installer exited with code $1"
  ${EndIf}
!macroend
