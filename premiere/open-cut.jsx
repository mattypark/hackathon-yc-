// jptr — open the imported auto-editor sequence in the Timeline (visible on screen).
// Finds the newest sequence in the project and opens it.
var proj = app.project;
if (proj.sequences.numSequences === 0) {
  return "no sequences in project — run import-cut.jsx first";
}
var seq = proj.sequences[proj.sequences.numSequences - 1];
proj.openSequence(seq.sequenceID);
proj.activeSequence = seq;
return "opened sequence: " + seq.name + " (" + proj.sequences.numSequences + " total)";
