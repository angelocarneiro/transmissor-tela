@echo off
title Transmissor de Tela
cd /d "%~dp0"
start "" http://localhost:3030/
node server.js 3030 --internet
pause
