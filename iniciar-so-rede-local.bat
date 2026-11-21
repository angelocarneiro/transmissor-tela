@echo off
title Transmissor de Tela (rede local)
cd /d "%~dp0"
start "" http://localhost:3030/transmitir
node server.js 3030
pause
