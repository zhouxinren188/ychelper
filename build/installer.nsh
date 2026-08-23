!macro customInit
  ; Older clients start the verified full installer immediately before calling app.quit().
  ; Give that already-running app a bounded grace period to leave the install directory.
  StrCpy $R8 0

  waitForYcHelperExit:
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R9
    ${If} $R9 != 0
      Goto ycHelperExitWaitDone
    ${EndIf}

    IntOp $R8 $R8 + 1
    ${If} $R8 >= 50
      Goto ycHelperExitWaitDone
    ${EndIf}

    Sleep 200
    Goto waitForYcHelperExit

  ycHelperExitWaitDone:
!macroend
