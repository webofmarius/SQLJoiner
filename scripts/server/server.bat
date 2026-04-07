@echo off
setlocal

cd /d "%~dp0..\..\app"

php -S 0.0.0.0:90
