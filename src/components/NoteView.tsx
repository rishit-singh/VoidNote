import { ArrowLeft, Menu, MoreHorizontal, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MutableRefObject, useEffect, useRef, useState } from "react";
import { Note, NoteModel } from "./Note";

import { Button } from "@/components/ui/button";
import SignOutButton from "./SignOutButton";
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

  const renameNote = (id: string, newName: string) => {
    const updatedNotes = notes.map((n) =>
      n.id === id ? { ...n, transcript: newName } : n
    );
    setNotes(updatedNotes);

    if (currentNote.current.id === id) {
      note.current.transcript = newName;
      updateNote();
    }
  };

  const NoteEntry = ({
    id,
    onClick,
  }: {
    id: string;
    onClick?: (note: NoteModel) => void;
  }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [currentName, setCurrentName] = useState<string>("");
    const inputRef = useRef<HTMLInputElement>(null);

    const noteData = notes.find((n) => n.id === id);
    const noteName = noteData?.transcript || `Note ${id.split("-")[0]}`;

    const isSelected = currentNote.current.id === id;

    useEffect(() => {
      if (isEditing) {
        setCurrentName(noteName); // Set the current name for editing
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select(); // Highlight the text
        }
      }
    }, [isEditing, noteName]);

    const handleSave = () => {
      if (currentName.trim() === "") {
        setCurrentName(noteName); // Revert to the original name if the input is empty
      } else {
        renameNote(id, currentName.trim());
      }
      setIsEditing(false);
    };

    return (
      <div
        className={`w-full flex items-center justify-between px-3 py-2 rounded-md ${
          isSelected ? "bg-gray-800" : "hover:bg-gray-700"
        } transition-colors`}
      >
        {isEditing ? (
          <input
            ref={inputRef}
            className="flex-grow text-white bg-transparent border border-gray-600 rounded-md px-2 py-1 focus:outline-none"
            value={currentName}
            onChange={(e) => setCurrentName(e.target.value)} // Update the state with the new input value
            onBlur={handleSave} // Save the name on blur
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave(); // Save on Enter
              if (e.key === "Escape") {
                setIsEditing(false); // Cancel editing on Escape
                setCurrentName(noteName); // Revert to the original name
              }
            }}
          />
        ) : (
          <span
            className="text-white flex-grow truncate cursor-pointer"
            onClick={() => {
              const foundNote = notes.find((note) => note.id === id);
              if (foundNote) {
                note.current = foundNote;
                onClick?.(foundNote);
                updateNote();
              }
            }}
          >
            {noteName}
          </span>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger>
            <MoreHorizontal className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="bg-gray-800 text-white rounded-md">
            <DropdownMenuItem
              className="cursor-pointer hover:bg-gray-700"
              onClick={() => setIsEditing(true)}
            >
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer hover:bg-gray-700"
              onClick={() => deleteNote(id)}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  // Reduce the spacing between notes
  <div className="space-y-0.5">
    {notes.length < 1 && (
      <Button
        variant="ghost"
        className="w-full justify-start text-gray-400"
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
      <NoteEntry key={n.id} id={n.id} />
    ))}
  </div>;

  useEffect(() => {
    console.log(currentNote.current);
  }, [currentNote]);

  return (
    <div className="flex h-screen bg-black text-white">
      {/* Sidebar */}
      {isSidebarOpen && (
        <div className="w-72 border-r border-gray-700 bg-gray-900 flex flex-col">
          <div className="p-6 relative">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 p-0 absolute top-2 right-2"
              onClick={() => setSidebarOpen(false)}
            >
           <ArrowLeft className="h-4 w-4 text-white" />
            </Button>
            <h1 className="text-2xl font-bold mb-6">YapNote</h1>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium">All Notes</h2>
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
            </div>
            <div className="space-y-1">
              {notes.length < 1 && (
                <Button
                  variant="ghost"
                  className="w-full justify-start text-gray-400"
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
                <NoteEntry key={n.id} id={n.id} />
              ))}
            </div>
          </div>
          <SignOutButton />
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex items-center justify-center bg-black">
        {!isSidebarOpen && (
          <Menu
            onClick={() => setSidebarOpen(true)}
            className="absolute h-7 w-7 top-4 left-4 z-50 flex items-center justify-center"
          />
        )}
        {currentNote.current.id !== "" ? (
          <div className="p-6 w-full max-w-4xl">
            <div className="mb-6 text-center">
          
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
