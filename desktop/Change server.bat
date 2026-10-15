@echo off
rem Opens Umbryx on its "add a server" screen. Close Umbryx first if it is open.
rem (Inside the app, the + at the bottom of the column of servers does the same.)
start "" "%~dp0Umbryx.exe" --setup
