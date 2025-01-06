import { Menu, Plus, X } from "lucide-react";
import { MutableRefObject, useEffect, useRef, useState } from "react";
import { Note, NoteModel } from "./Note";

import { Button } from "@/components/ui/button";
import SignOutButton from "./SignOutButton";
import { TrashIcon } from "@radix-ui/react-icons";
import { useLocalStorage } from "@/hooks/useLocalStorage";

export default function NoteView() {
  const note = useRef<NoteModel>({
    id: "",
    transcript: "",
    diarizationResults: [],
    createdAt: null,
    audio: null,
    url: null,
  });

  const [currentNote, setCurrentNote] =
    useState<MutableRefObject<NoteModel>>(note);
  const [notes, setNotes] = useLocalStorage<NoteModel[]>("notes", []);
  const [isSidebarOpen, setSidebarOpen] = useState(true);

  const updateNote = () => {
    setCurrentNote(note);
    const noteIndex = notes.findIndex((n) => n.id === note.current.id);
    if (noteIndex >= 0) {
      const updatedNotes = [...notes];
      updatedNotes[noteIndex] = note.current;
      setNotes(updatedNotes);
    }
  };

  const createNote = (): NoteModel => {
    const newNote: NoteModel = {
      id: crypto.randomUUID(),
      transcript: "",
      diarizationResults: [],
      createdAt: new Date(),
      audio: null,
      url: null,
    };

    note.current = newNote;
    return newNote;
  };

  const deleteNote = (id: string) => {
    const updatedNotes = notes.filter((n) => n.id !== id);
    setNotes(updatedNotes);

    if (currentNote.current.id === id || updatedNotes.length === 0) {
      currentNote.current = {
        id: "",
        transcript: "",
        diarizationResults: [],
        createdAt: null,
        audio: null,
        url: null,
      };
      updateNote();
    }
  };

  useEffect(() => {
    console.log(currentNote.current);
  }, [currentNote]);

  return (
    <div className="flex h-screen bg-black text-white">
      {/* Sidebar */}
      {isSidebarOpen && (
        <div className="w-72 border-r border-border bg-black flex flex-col">
          <div className="p-6 relative">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 p-0 absolute top-2 right-2"
              onClick={() => setSidebarOpen(false)}
            >
              <X className="h-4 w-4 text-white" />
            </Button>
            <h1 className="text-2xl font-bold mb-6">YapNote</h1>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium">Notes</h2>
              {notes.length >= 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 p-0"
                  onClick={() => {
                    const newNote = createNote();
                    setNotes([...notes, newNote]);
                    note.current = newNote;
                    updateNote();
                  }}
                >
                  <Plus className="h-4 w-4 text-white" />
                </Button>
              )}
            </div>
            <div className="space-y-1">
              {notes.length < 1 && (
                <Button
                  variant="ghost"
                  className="w-full justify-start text-muted-foreground"
                  onClick={() => {
                    const newNote = createNote();
                    setNotes([newNote]);
                    note.current = newNote;
                    updateNote();
                  }}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  New Note
                </Button>
              )}
              {notes.map((n) => (
                <div
                  key={n.id}
                  className="group flex items-center justify-between"
                >
                  <Button
                    className={`text-gray-300 bg-transparent hover:text-gray-100 hover:bg-gray-800 transition-transform cursor-pointer flex-1 ${
                      currentNote.current.id === n.id ? "bg-gray-800" : ""
                    }`}
                    onClick={() => {
                      const foundNote = notes.find((note) => note.id === n.id);
                      if (foundNote) {
                        note.current = foundNote;
                        updateNote();
                      }
                    }}
                  >
                    Note {n.id.split("-")[0]}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground invisible group-hover:visible hover:text-white bg-transparent hover:bg-gray-700 h-8 w-8 p-0 mr-1"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteNote(n.id);
                    }}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-auto p-6">
            <SignOutButton />
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex items-center justify-center bg-black">
      {!isSidebarOpen && (
        <Button
          variant="ghost"
          className="absolute h-10 w-10 top-4 left-4 z-50 flex items-center justify-center"
          onClick={() => setSidebarOpen(true)}
        >
  
          <Menu className="h-10 w-10 text-white" />
        </Button>
      )}
        {currentNote.current.id !== "" ? (
          <div className="p-6 w-full max-w-4xl">
            <div className="mb-6 text-center">
              <h2 className="text-lg font-semibold text-white mb-4">
                Editing Note {currentNote.current?.id?.split("-")[0] || ""}
              </h2>
            </div>
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
