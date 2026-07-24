; Custom NSIS include — electron-builder auto-detects this at
; <buildResources>/installer.nsh and inserts the macros below into the
; generated installer.
;
; kuzu's native module (kuzujs.node) links against the Microsoft Visual C++
; 2015–2022 x64 runtime. Without it, loading the module fails on Windows with
; "The specified module could not be found" and the app's graph-memory feature
; stays disabled. We install the runtime here so it works out of the box.
;
; vc_redist.x64.exe is fetched into <buildResources> by scripts/before-pack.cjs
; before packaging, so ${BUILD_RESOURCES_DIR}\vc_redist.x64.exe exists at
; makensis time. The redist is idempotent; we still skip it when the runtime is
; already registered, so most users see no extra step.

!include "LogicLib.nsh"

; Replace electron-builder's built-in "is the app running?" check (used by BOTH
; the installer and the uninstaller). The stock check loops forever here on
; "Glyphh Desktop cannot be closed" because:
;   * Glyphh can stay resident in the BACKGROUND (tray) and refuses the graceful
;     close the stock check asks for, and
;   * Electron runs several processes all named ${APP_EXECUTABLE_FILENAME}
;     (main, GPU, renderer, utility), and the stock kill uses /im WITHOUT /t, so
;     the process count never reaches zero and it falls through to the box.
; Defining customCheckAppRunning REPLACES that check: force TREE-kill the whole
; group (two passes to absorb Electron's child respawns), then proceed. No
; prompt, no infinite loop.
; The blocking "cannot be closed" prompt during install is NOT the app-running
; check — it comes from extractAppPackage.nsh, where CopyFiles into $INSTDIR
; fails 5 times because something still holds a file there. Killing only
; ${APP_EXECUTABLE_FILENAME} is not enough: helper processes launched from the
; install folder (notably the Claude Agent SDK's claude.exe under
; resources\app.asar.unpacked\...) keep handles open under a different name.
; So: kill the app by name AND anything whose image path is inside $INSTDIR.
!macro _glyphhKill
  DetailPrint "Glyphh: clearing any running instances..."
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  ; Path-scoped: terminates claude.exe and any other bundled helper running out
  ; of the install dir, without touching unrelated processes of the same name.
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process | Where-Object { $$_.Path -like '$INSTDIR\*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $0
  Sleep 1000
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 400
!macroend

; Belt-and-braces: kill early in .onInit AND replace the running-app check.
!macro customInit
  !insertmacro _glyphhKill
!macroend

; Replacing customCheckAppRunning REPLACES electron-builder's built-in check
; entirely (installer + uninstaller), so its "cannot be closed" prompt never
; runs — Glyphh's background/tray process + Electron's several same-named
; processes made the stock check (which kills without /t) loop forever.
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
