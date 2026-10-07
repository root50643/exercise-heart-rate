@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if not errorlevel 1 (
  node server.mjs
  goto done
)
where py >nul 2>&1
if not errorlevel 1 (
  py -3 -c "import sys; assert sys.version_info.major == 3" >nul 2>&1
  if not errorlevel 1 (
    py -3 server.py
    goto done
  )
)
where python >nul 2>&1
if not errorlevel 1 (
  python -c "import sys; assert sys.version_info.major == 3" >nul 2>&1
  if not errorlevel 1 (
    python server.py
    goto done
  )
)
echo Please install Node.js 18+ or Python 3 and add it to PATH, then try again.
:done
pause
endlocal
