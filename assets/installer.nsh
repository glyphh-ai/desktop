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

; Glyphh can stay resident in the BACKGROUND (tray) after its window is closed —
; when background mode is on, closing the window hides it and the process keeps
; running. The installer's built-in "app is running" check then loops forever on
; "Glyphh Desktop cannot be closed…" even though the user sees no window, and a
; graceful close never works because background mode refuses it. Force-terminate
; any lingering process (tree) at the very start, before that check runs. Errors
; (nothing running) are ignored. customUnInit does the same for uninstall.
!macro customInit
  nsExec::Exec 'taskkill /F /T /IM "${PRODUCT_FILENAME}.exe"'
  Pop $0
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /T /IM "${PRODUCT_FILENAME}.exe"'
  Pop $0
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
