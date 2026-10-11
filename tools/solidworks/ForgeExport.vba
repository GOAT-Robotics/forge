' ForgeExport — one click in SolidWorks exports the active part or assembly as a Forge package (.forge)
' and, with forge-export.json next to forge_export.py, uploads it to Forge.
'
' Setup (once per machine, 2 minutes):
'   1. Put forge_export.py (and optionally forge-export.json) in a folder, e.g. C:\Forge\.
'   2. SolidWorks > Tools > Macro > New…  → save as C:\Forge\ForgeExport.swp. The VBA editor opens.
'   3. Replace everything in the module with this file's contents. Save (Ctrl+S) and close the editor.
'   4. Toolbar button: Tools > Customize > Commands > category "Macro" → drag "New Macro Button" onto any
'      toolbar → choose C:\Forge\ForgeExport.swp, method "main", tooltip "Forge export". OK.
'      (Or run it with Tools > Macro > Run…, or give it a keyboard shortcut under Customize > Keyboard.)
'
' The exporter runs in its own console window so SolidWorks stays responsive while it reads the model
' (it talks to SolidWorks over COM, which needs SolidWorks' message loop running).
Option Explicit

Const PYTHON As String = "py"      ' Python launcher; or a full path such as "C:\Python312\python.exe"
Const SCRIPT As String = ""        ' empty = forge_export.py in the same folder as this macro

Sub main()
    Dim swApp As Object
    Dim swModel As Object
    Set swApp = Application.SldWorks
    Set swModel = swApp.ActiveDoc
    If swModel Is Nothing Then
        MsgBox "Open the part or assembly to export first.", vbExclamation, "Forge export"
        Exit Sub
    End If
    If swModel.GetType = 3 Then   ' swDocDRAWING
        MsgBox "Drawings cannot be exported; activate the part or the assembly.", vbExclamation, "Forge export"
        Exit Sub
    End If

    Dim docPath As String
    docPath = swModel.GetPathName
    If docPath = "" Then
        MsgBox "Save the document first; the exporter works from the saved file.", vbExclamation, "Forge export"
        Exit Sub
    End If
    If swModel.GetSaveFlag Then
        If MsgBox("The document has unsaved changes. Save it and export?", vbYesNo + vbQuestion, "Forge export") <> vbYes Then Exit Sub
        Dim errs As Long, warns As Long
        If Not swModel.Save3(1, errs, warns) Then   ' 1 = swSaveAsOptions_Silent
            MsgBox "Save failed (error " & errs & "); export cancelled.", vbCritical, "Forge export"
            Exit Sub
        End If
    End If

    Dim script As String
    script = SCRIPT
    If script = "" Then
        Dim macroPath As String
        macroPath = swApp.GetCurrentMacroPathName
        script = Left$(macroPath, InStrRev(macroPath, "\")) & "forge_export.py"
    End If
    If Dir(script) = "" Then
        MsgBox "forge_export.py was not found at" & vbCrLf & script & vbCrLf & vbCrLf & "Put it next to the macro or set SCRIPT at the top of the macro.", vbCritical, "Forge export"
        Exit Sub
    End If

    ' Asynchronous on purpose: the exporter drives SolidWorks over COM, so this macro must return at once.
    Dim cmd As String
    cmd = "cmd.exe /c """ & PYTHON & " """ & script & """ """ & docPath & """ --from-macro"""
    Shell cmd, vbNormalFocus
End Sub
