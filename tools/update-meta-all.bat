@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "DEFAULT_DIR=%~dp0..\playlist\Anime\Series"

:MENU
cls
echo ==========================================
echo   Update Metadata - All Files
echo ==========================================
echo.
echo  Folder: %DEFAULT_DIR%
echo.
set "FOLDER=%DEFAULT_DIR%"
set /p FOLDER=Folder path (leave blank = default):
if "!FOLDER!"=="" set "FOLDER=%DEFAULT_DIR%"

if not exist "!FOLDER!" (
    echo.
    echo  ERROR: Folder not found: !FOLDER!
    echo.
    pause
    goto MENU
)

echo.
echo  Mode:
echo    1 = all    (poster + cover + title)
echo    2 = poster (series/season/track cover image only)
echo    3 = cover  (episode thumbnails only)
echo    4 = title  (episode titles only)
echo.
set "META_CHOICE=1"
set /p META_CHOICE=Select mode [1]:
if "!META_CHOICE!"=="" set "META_CHOICE=1"
if "!META_CHOICE!"=="1" (set "META_MODE=all") else if "!META_CHOICE!"=="2" (set "META_MODE=poster") else if "!META_CHOICE!"=="3" (set "META_MODE=cover") else if "!META_CHOICE!"=="4" (set "META_MODE=title") else (set "META_MODE=all")

echo.
set "SEASON="
set /p SEASON=Season number (leave blank = all seasons):

echo.
echo  Track filter:
echo    0 = all tracks (default)
echo    1 = th    (dubbed only)
echo    2 = subth (subbed only)
echo.
set "TRACK_CHOICE=0"
set /p TRACK_CHOICE=Select track [0]:
if "!TRACK_CHOICE!"=="" set "TRACK_CHOICE=0"
if "!TRACK_CHOICE!"=="1" (set "TRACK_OPT=--track=th") else if "!TRACK_CHOICE!"=="2" (set "TRACK_OPT=--track=subth") else (set "TRACK_OPT=")

:: Build base command options
set "META_OPT=--update-meta"
if not "!META_MODE!"=="all" set "META_OPT=--update-meta=!META_MODE!"

set "SEASON_OPT="
if not "!SEASON!"=="" set "SEASON_OPT=--season=!SEASON!"

:: Count files
set "TOTAL=0"
for %%f in ("!FOLDER!\*.txt") do (
    if /i not "%%~nxf"=="index.txt" set /a TOTAL+=1
)

echo.
echo  Found !TOTAL! file(s) in:
echo  !FOLDER!
echo.
echo  Settings: mode=!META_MODE! season=!SEASON! track=!TRACK_OPT!
echo.
set "CONFIRM=n"
set /p CONFIRM=Start update? (y/n) [n]:
if /i not "!CONFIRM!"=="y" goto MENU

:: Process each file
echo.
echo ==========================================
set "COUNT=0"
set "ERRORS=0"

for %%f in ("!FOLDER!\*.txt") do (
    if /i not "%%~nxf"=="index.txt" (
        set /a COUNT+=1
        echo.
        echo [!COUNT!/!TOTAL!] %%~nxf
        echo ------------------------------------------

        set "CMD=node fetch-anime-kimi.js !META_OPT!"
        if not "!SEASON_OPT!"=="" set "CMD=!CMD! !SEASON_OPT!"
        if not "!TRACK_OPT!"=="" set "CMD=!CMD! !TRACK_OPT!"
        set "CMD=!CMD! --output=%%~nxf"

        echo  ^> !CMD!
        echo.
        !CMD!
        if errorlevel 1 (
            set /a ERRORS+=1
            echo  [FAILED] %%~nxf
        )
    )
)

echo.
echo ==========================================
echo  Done: !COUNT! file(s) processed, !ERRORS! error(s)
echo ==========================================

:AGAIN
echo.
set "AGAIN=n"
set /p AGAIN=Run again? (y/n) [n]:
if /i "!AGAIN!"=="y" goto MENU

:END
endlocal
exit /b 0
