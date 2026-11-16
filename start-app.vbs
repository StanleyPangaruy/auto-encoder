' The desktop shortcut runs this: it starts Auto-Encoder with no window and opens it in the browser.
' (A .cmd file would leave a black window open; Windows Script Host can run Node hidden.)
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = root
shell.Run "node """ & root & "\scripts\launch.js""", 0, False
