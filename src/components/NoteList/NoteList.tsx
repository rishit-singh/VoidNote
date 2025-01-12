import { Button } from "@/components/ui/button";
import NoteEntry from "../NoteEntry/NoteEntry";
import { NoteModel } from "@/types/types";
import { Plus } from "lucide-react";

interface NoteListProps {
  notes: NoteModel[];
  currentNoteId: string;
  onNoteSelect: (note: NoteModel) => void;
  onNoteCreate: () => void;
  onNoteRename: (id: string, newName: string) => void;
  onNoteDelete: (id: string) => void;
}

export const NoteList: React.FC<NoteListProps> = ({
  notes,
  currentNoteId,
  onNoteSelect,
  onNoteCreate,
  onNoteRename,
  onNoteDelete,
}) => {
  if (notes.length === 0) {
    return (
      <Button
        variant="ghost"
        className="w-full justify-start text-gray-400"
        onClick={onNoteCreate}
      >
        <Plus className="mr-2 h-4 w-4" />
        New Note
      </Button>
    );
  }

  return (
    <div className="space-y-1">
      {notes.map((note) => (
        <NoteEntry
          key={note.id}
          note={note}
          isSelected={currentNoteId === note.id}
          onSelect={onNoteSelect}
          onRename={onNoteRename}
          onDelete={onNoteDelete}
        />
      ))}
    </div>
  );
};
