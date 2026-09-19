; User memory lives outside BUNDLEID and INSTDIR. Never remove brain folders.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Mneme"
  ${EndIf}
!macroend
