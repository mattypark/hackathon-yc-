// jptr — import auto-editor's cut timeline (output/timeline.xml) into the
// open Premiere project. Sent via send-jsx.sh through the MCP Bridge.
var projectRoot = "/Users/matthewpark/Downloads/current-projects/jptr";
var xmlPath = projectRoot + "/output/timeline.xml";

var f = new File(xmlPath);
if (!f.exists) { return "ERROR: timeline.xml not found at " + xmlPath; }

var ok = app.project.importFiles([xmlPath], true, app.project.getInsertionBin(), false);
return ok ? "imported timeline.xml — sequence should appear in project panel" : "importFiles returned false";
