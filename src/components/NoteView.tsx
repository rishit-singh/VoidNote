import { Menu } from "lucide-react";
import { Note } from "./Note";
import { NoteModel } from "@/types/types";
import { Sidebar } from "@/sidebar/Sidebar";
import { useNote } from "../hooks/useNote";
import { useState } from "react";

export default function NoteView() {
  const {
    noteRef,
    currentNote,
    notes,
    setNotes,
    createNote,
    updateNote,
    deleteNote,
    renameNote,
  } = useNote();
  const [isSidebarOpen, setSidebarOpen] = useState(true);

  const handleCreateNote = () => {
    const newNote = createNote();
    setNotes([...notes, newNote]);
    noteRef.current = newNote;
    updateNote();
  };

  const handleNoteSelect = (note: NoteModel) => {
    noteRef.current = note;
    updateNote();
  };

  return (
    <div className="flex h-screen bg-black text-white">
      <Sidebar
        isOpen={isSidebarOpen}
        onClose={() => setSidebarOpen(false)}
        notes={notes}
        currentNoteId={currentNote.current.id}
        onNoteSelect={handleNoteSelect}
        onNoteCreate={handleCreateNote}
        onNoteRename={renameNote}
        onNoteDelete={deleteNote}
      />

      <div className="flex-1 flex items-center justify-center bg-black">
        {!isSidebarOpen && (
          <Menu
            onClick={() => setSidebarOpen(true)}
            className="absolute h-7 w-7 top-4 left-4 z-50 flex items-center justify-center cursor-pointer"
          />
        )}

        {currentNote.current.id !== "" ? (
          <div className="p-6 w-full max-w-4xl">
            <Note noteRef={currentNote} onResult={updateNote} />
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center p-20 bg-gray-900">
            <p className="text-lg text-gray-500">No note selected</p>
            <p className="text-sm text-gray-400 mt-2">
              Create or select a note to get started.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
