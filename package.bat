@echo off
:: Di chuyển vào thư mục chứa file script
cd /d "%~dp0"

echo ==================================================
echo   Dang bat dau qua trinh dong goi extension...
echo ==================================================
echo.

:: Chạy lệnh đóng gói dùng npx vsce package
call npx vsce package

if %ERRORLEVEL% equ 0 (
    echo.
    echo ==================================================
    echo [THANH CONG] Extension da duoc dong goi thanh cong!
    echo ==================================================
) else (
    echo.
    echo ==================================================
    echo [THAT BAI] Co loi xay ra trong qua trinh dong goi.
    echo ==================================================
)

pause
