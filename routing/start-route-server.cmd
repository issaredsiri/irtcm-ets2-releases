@echo off
title Truck Dash route server
rem route-server.ts imports TruckSim Maps modules, so it runs from inside routing\maps
if not exist "%~dp0maps\ets2dash" mkdir "%~dp0maps\ets2dash"
copy /y "%~dp0ets2dash\*.ts" "%~dp0maps\ets2dash\" >nul
cd /d "%~dp0maps" || exit /b 1
"%~dp0node\node.exe" --max-old-space-size=8192 --import tsx ets2dash\route-server.ts
pause
