@echo off
setlocal EnableExtensions
title Ghost Foundry - GitHub'a yukle
cd /d "%~dp0"

echo.
echo  ==================================================
echo    Ghost Foundry - GitHub'a otomatik yukleme
echo  ==================================================
echo.

if not exist "package.json" goto :wrong_folder
if not exist "src\server.js" goto :wrong_folder

rem ---------------------------------------------------------------
rem  1) Git kurulu mu?
rem ---------------------------------------------------------------
call :find_git
if not errorlevel 1 goto :git_ready
echo  [!] Bilgisayarinda Git bulunamadi.
call :winget_install Git.Git "Git"
call :find_git
if errorlevel 1 goto :need_git
:git_ready

rem ---------------------------------------------------------------
rem  2) Yerel depo
rem ---------------------------------------------------------------
if not exist ".gitignore" call :write_gitignore
if exist ".git\" goto :repo_exists
echo  [*] Yerel git deposu olusturuluyor...
git init -q
if errorlevel 1 goto :fail
git symbolic-ref HEAD refs/heads/main
:repo_exists
git rev-parse --is-inside-work-tree >nul 2>&1
if not errorlevel 1 goto :repo_ok
git config --global --add safe.directory "%CD:\=/%"
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 goto :repo_broken
:repo_ok

rem ---------------------------------------------------------------
rem  3) GitHub baglantisi (yalnizca ilk calistirmada)
rem ---------------------------------------------------------------
set "GHUSER="
set "GHID="
git remote get-url origin >nul 2>&1
if not errorlevel 1 goto :remote_ok
call :setup_remote
if errorlevel 1 goto :fail
:remote_ok

rem ---------------------------------------------------------------
rem  4) Commit kimligi (yalnizca ilk calistirmada sorulur)
rem ---------------------------------------------------------------
set "GNAME="
set "GMAIL="
for /f "delims=" %%A in ('git config user.name 2^>nul') do set "GNAME=%%A"
for /f "delims=" %%A in ('git config user.email 2^>nul') do set "GMAIL=%%A"
if defined GNAME if defined GMAIL goto :identity_ok
echo.
echo  Commitlerde gorunecek kimlik (sadece bu proje icin kaydedilir).
echo  Varsayilan e-posta GitHub'in gizli "noreply" adresidir; gercek adresin gorunmez.
if not defined GNAME set "GNAME=%GHUSER%"
:ask_name
set /p "GNAME=  Ad [%GNAME%]: "
if not defined GNAME goto :ask_name
if not defined GMAIL call :default_mail
:ask_mail
set /p "GMAIL=  E-posta [%GMAIL%]: "
if not defined GMAIL goto :ask_mail
git config user.name "%GNAME%"
git config user.email "%GMAIL%"
:identity_ok

rem ---------------------------------------------------------------
rem  5) Guvenlik kontrolleri + commit
rem ---------------------------------------------------------------
echo.
echo  [*] Dosyalar hazirlaniyor ve guvenlik kontrolu yapiliyor...
git check-ignore -q .env
if errorlevel 1 goto :env_not_ignored
git add -A
if errorlevel 1 goto :fail
set "LEAK="
for /f "delims=" %%F in ('git ls-files -- .env') do set "LEAK=1"
if defined LEAK goto :env_staged
git grep --cached -I -l -E -e "sk-or-v1-[A-Za-z0-9]{16,}" -e "ghp_[A-Za-z0-9]{30,}" -e "github_pat_[A-Za-z0-9_]{30,}" > "%TEMP%\gf-secrets.txt" 2>nul
if not errorlevel 1 goto :secret_found
echo  [*] Guvenlik kontrolu temiz: .env ve API anahtarlari yuklenmeyecek.

git diff --cached --quiet
if not errorlevel 1 goto :no_changes
set "MSG=%~1"
if defined MSG goto :do_commit
set "MSG=Ghost Foundry guncellemesi"
git rev-parse --verify -q HEAD >nul 2>&1
if errorlevel 1 set "MSG=Ghost Foundry ilk yukleme"
:do_commit
git commit -q -m "%MSG%"
if errorlevel 1 goto :fail
echo  [*] Commit olusturuldu: %MSG%
goto :push
:no_changes
echo  [*] Yeni degisiklik yok; GitHub ile esitleniyor.

rem ---------------------------------------------------------------
rem  6) Push
rem ---------------------------------------------------------------
:push
set "BR="
for /f "delims=" %%B in ('git rev-parse --abbrev-ref HEAD') do set "BR=%%B"
if not defined BR set "BR=main"
set "URL="
for /f "delims=" %%U in ('git remote get-url origin') do set "URL=%%U"
echo.
echo  [*] GitHub'a gonderiliyor (dal: %BR%)...
echo      Ilk seferde tarayicida GitHub girisi istenebilir; onayla ve bu pencereye don.
git push -u origin %BR%
if not errorlevel 1 goto :success
echo.
echo  [!] Gonderim reddedildi. GitHub'daki repoda burada olmayan commitler olabilir.
echo      Uzak degisiklikler cekilip birlestiriliyor (cakismada bu bilgisayardaki surum korunur)...
git pull --no-rebase --no-edit --allow-unrelated-histories -X ours origin %BR%
if errorlevel 1 goto :sync_failed
git push -u origin %BR%
if errorlevel 1 goto :sync_failed

:success
set "WEB=%URL:.git=%"
echo.
echo  ==================================================
echo    Tamam! Proje GitHub'da:
echo    %WEB%
echo  ==================================================
echo  Sonraki guncellemelerde bu dosyayi tekrar calistirman yeterli.
echo.
pause
exit /b 0

rem ===============================================================
rem  Alt rutinler
rem ===============================================================
:find_git
where git >nul 2>&1
if not errorlevel 1 exit /b 0
if not exist "%ProgramFiles%\Git\cmd\git.exe" exit /b 1
set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
exit /b 0

:find_gh
where gh >nul 2>&1
if not errorlevel 1 exit /b 0
if not exist "%ProgramFiles%\GitHub CLI\gh.exe" exit /b 1
set "PATH=%ProgramFiles%\GitHub CLI;%PATH%"
exit /b 0

:winget_install
where winget >nul 2>&1
if errorlevel 1 exit /b 1
choice /C EH /M "  %~2 simdi winget ile kurulsun mu"
if errorlevel 2 exit /b 1
winget install --id %1 -e --source winget --accept-package-agreements --accept-source-agreements
exit /b 0

:write_gitignore
> ".gitignore" echo node_modules/
>> ".gitignore" echo .env
>> ".gitignore" echo .env.*
>> ".gitignore" echo !.env.example
>> ".gitignore" echo data/
>> ".gitignore" echo artifacts/
>> ".gitignore" echo logs/
>> ".gitignore" echo *.log
exit /b 0

:ask_repo
set "REPO=ghost-foundry"
set /p "REPO=  Repo adi [ghost-foundry]: "
set "REPO=%REPO: =-%"
set "VIS=--private"
choice /C GA /N /M "  Repo gizli mi (G) olsun, herkese acik mi (A)? [G/A]: "
if errorlevel 2 set "VIS=--public"
exit /b 0

:default_mail
if not defined GHUSER exit /b 0
if defined GHID set "GMAIL=%GHID%+%GHUSER%@users.noreply.github.com"
if not defined GHID set "GMAIL=%GHUSER%@users.noreply.github.com"
exit /b 0

:setup_remote
call :find_gh
if not errorlevel 1 goto :remote_gh
echo.
echo  GitHub CLI (gh) kurulu degil. Kurulursa repo GitHub'da otomatik olusturulur;
echo  kurmazsan repoyu tarayicida senin olusturman gerekir (1 dakika).
call :winget_install GitHub.cli "GitHub CLI"
call :find_gh
if not errorlevel 1 goto :remote_gh
goto :remote_manual

:remote_gh
gh auth status >nul 2>&1
if not errorlevel 1 goto :gh_authed
echo.
echo  [*] GitHub girisi: tarayici acilacak. Ekrandaki kodu girip onayla.
gh auth login --hostname github.com --git-protocol https --web
gh auth status >nul 2>&1
if not errorlevel 1 goto :gh_authed
echo  [!] GitHub girisi tamamlanmadi.
exit /b 1
:gh_authed
gh auth setup-git >nul 2>&1
for /f "delims=" %%A in ('gh api user --jq .login 2^>nul') do set "GHUSER=%%A"
for /f "delims=" %%A in ('gh api user --jq .id 2^>nul') do set "GHID=%%A"
if not defined GHUSER goto :remote_manual
echo  [*] GitHub hesabi: %GHUSER%
call :ask_repo
gh repo view "%GHUSER%/%REPO%" >nul 2>&1
if not errorlevel 1 goto :gh_repo_exists
echo  [*] GitHub'da %GHUSER%/%REPO% olusturuluyor...
gh repo create "%REPO%" %VIS% --description "Ghost Foundry - otonom mikro-arac ve evrimsel ajan ekosistemi" --source . --remote origin
if errorlevel 1 exit /b 1
exit /b 0
:gh_repo_exists
echo  [*] %GHUSER%/%REPO% zaten var; ona baglaniliyor.
git remote add origin "https://github.com/%GHUSER%/%REPO%.git"
exit /b 0

:remote_manual
echo.
:ask_user
if not defined GHUSER set /p "GHUSER=  GitHub kullanici adin: "
if not defined GHUSER goto :ask_user
call :ask_repo
set "VISNAME=private"
if "%VIS%"=="--public" set "VISNAME=public"
echo.
echo  Tarayicida GitHub'in yeni repo sayfasi acilacak.
echo  Ad: %REPO%  -  README, .gitignore veya lisans EKLEME; sadece "Create repository" de.
start "" "https://github.com/new?name=%REPO%&visibility=%VISNAME%"
echo  Repoyu olusturduktan sonra buraya donup bir tusa bas.
pause
git remote add origin "https://github.com/%GHUSER%/%REPO%.git"
exit /b 0

rem ===============================================================
rem  Hata mesajlari
rem ===============================================================
:wrong_folder
echo  [!] Bu dosya ghost-foundry klasorunun icinde olmali (package.json ile ayni yerde).
goto :fail

:need_git
echo  [!] Git olmadan devam edilemez.
echo      https://git-scm.com/download/win adresinden kur, sonra bu dosyayi tekrar calistir.
start "" "https://git-scm.com/download/win"
goto :fail

:repo_broken
echo  [!] Git bu klasoru depo olarak acamadi. Klasor izinlerini kontrol et.
goto :fail

:env_not_ignored
echo  [!] GUVENLIK: .env dosyasi .gitignore ile dislanmiyor; API anahtarin sizabilirdi.
echo      .gitignore dosyasina ".env" satirini ekleyip tekrar dene. Hicbir sey gonderilmedi.
goto :fail

:env_staged
git reset -q
echo  [!] GUVENLIK: .env dosyasi daha once git'e eklenmis.
echo      Kaldirmak icin bu klasorde calistir:  git rm --cached .env
echo      Hicbir sey gonderilmedi.
goto :fail

:secret_found
git reset -q
echo  [!] GUVENLIK: Su dosyalarda API anahtari veya jeton gibi gorunen bir deger var:
type "%TEMP%\gf-secrets.txt"
echo      Anahtari bu dosyalardan silip yalnizca .env icinde tut. Hicbir sey gonderilmedi.
goto :fail

:sync_failed
git merge --abort >nul 2>&1
echo.
echo  [!] GitHub'a gonderilemedi. Olasi nedenler:
echo      - GitHub girisi iptal edildi ya da tamamlanmadi
echo      - Repo GitHub'da yok veya adi farkli: %URL%
echo      - Internet baglantisi yok
echo      Commitlerin bu bilgisayarda duruyor; sorunu giderip dosyayi tekrar calistir.
goto :fail

:fail
echo.
echo  Islem tamamlanamadi. Yukaridaki mesaja bak.
echo.
pause
exit /b 1
