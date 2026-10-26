@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Meteor — хост

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установите с https://nodejs.org (нужна версия 22 или новее^).
  echo.
  pause
  exit /b 1
)

rem Порт берём из config.json, чтобы батник не разъехался с настройками.
set PORT=7777
for /f "usebackq delims=" %%p in (`node -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync('config.json','utf8')).port||7777))}catch(e){process.stdout.write('7777')}"`) do set PORT=%%p

rem Две копии хоста ходят на релей под одним .agent.json: релей отцепляет
rem предыдущее соединение, хост переподключается, и так по кругу. Поэтому
rem второй запуск не разрешаем.
netstat -ano | findstr /c:":%PORT% " | findstr /i "LISTENING" >nul
if not errorlevel 1 (
  echo Хост уже запущен — порт %PORT% занят.
  echo Второй экземпляр будет драться с первым за подключение к релею, поэтому не запускаю.
  echo.
  echo Открыть панель: http://127.0.0.1:%PORT%/
  echo Остановить запущенный: закройте его окно, либо `taskkill /f /im node.exe`
  echo (учтите: taskkill по имени закроет все процессы Node, а не только хост^)
  echo.
  pause
  exit /b 1
)

echo Запускаю хост на порту %PORT%...
echo Панель:  http://127.0.0.1:%PORT%/
echo Оверлей: http://127.0.0.1:%PORT%/overlay.html?obs=1
echo.
echo Это окно — лог. Закрыть окно = остановить хост (Ctrl+C тоже).
echo.

start "" "http://127.0.0.1:%PORT%/"
node server/index.mjs

rem Сюда попадаем, если хост упал или его остановили — окно не должно закрыться
rem молча, иначе причину не прочитать.
echo.
echo Хост остановлен (код %errorlevel%^).
pause
