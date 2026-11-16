@echo off
rem Starts n8n at http://localhost:5678 with the Execute Command node enabled.
rem n8n 2.x disables that node by default; the workflow needs it to run the encoder.
set NODES_EXCLUDE=[]
rem Keep n8n's database inside this project instead of the user profile.
set N8N_USER_FOLDER=%~dp0n8n\data
cd /d "%~dp0n8n"
call node_modules\.bin\n8n.cmd start
