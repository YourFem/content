@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem Publikuva podpisanite statii ot Dropbox v YourFem/content.
rem
rem   dvoen klik                      - tarsi articles.json na obichaynoto myasto
rem   provlachi articles.json varhu   - polzva tozi fail
rem   set YOURFEM_ARTICLES=...        - ili go posochi vednazh taka
rem
rem articles.json se CHETE SAMO. Nishto v Dropbox ne se promenya i ne se trie.
rem Kakvo se e promenilo, reshava skriptat po heshovete; ti kazvash samo ZASHTO.

where node >nul 2>&1 || (echo NYAMA Node.js. Instalirai go ot https://nodejs.org i opitay pak. & goto :fail)
where git >nul 2>&1 || (echo NYAMA git. Instalirai go ot https://git-scm.com i opitay pak. & goto :fail)

set "SOURCE=%~1"
if "%SOURCE%"=="" set "SOURCE=%YOURFEM_ARTICLES%"
if "%SOURCE%"=="" set "SOURCE=%USERPROFILE%\Dropbox\mvp\app\data\articles.json"
if not exist "%SOURCE%" (
  echo Ne namiram %SOURCE%
  echo Provlachi articles.json varhu PUBLIKUVAY.cmd.
  goto :fail
)
echo Iztochnik: %SOURCE%

echo.
echo --- 1 poslednata versiya ot GitHub ---
git pull --ff-only || goto :fail
if not exist node_modules (call npm install --no-audit --no-fund || goto :fail)

echo.
set "NOTE="
set /p "NOTE=Kakvo se promeni i zashto? (po zhelanie, Enter = nishto): "

echo.
echo --- 2 portata ---
node tools\publish.mjs "%SOURCE%" --note "%NOTE%" || goto :fail

git add -A
git diff --cached --quiet && (echo. & echo Nyama nishto novo za kachvane. & goto :end)

echo.
echo --- 3 kachvane ---
if defined NOTE (
  git commit -q -m "Publish from the author's articles" -m "%NOTE%" || goto :fail
) else (
  git commit -q -m "Publish from the author's articles" || goto :fail
)
git push || goto :fail

echo.
echo GOTOVO. Promenite sa v YourFem/content; CHANGELOG.md kazva kakvo izleze.
echo Prilozhenieto gi vzema pri sledvashtiya build (npm run content:pull).
goto :end

:fail
echo.
echo NESHTO SE OBARKA - nishto ne e kacheno. Izprati tozi prozorets na Niki.

:end
echo.
pause
